import puppeteer, { Browser, Page, LaunchOptions } from "puppeteer-core";
import * as fs from "fs";
import * as path from "path";

const PROGRESS_FILE = "progress.json";
const DATA_DIR = "data";
// CONCURRENCY_LIMIT, RETRY_LIMIT, DELAY_BETWEEN_REQUESTS, BATCH_SIZE vẫn là hằng số,
// có thể đưa vào cấu hình nếu muốn mở rộng sau
const CONCURRENCY_LIMIT = 8;
const MAX_CHAPTERS_TO_CHECK = 5000;
const RETRY_LIMIT = 3;
const DELAY_BETWEEN_REQUESTS = 150;
const BATCH_SIZE = 50;

// Các hằng số mặc định nếu người dùng không cung cấp
const DEFAULT_CONNECTION_POOL_SIZE = 3;
const DEFAULT_PAGE_POOL_SIZE = 5;

interface Progress {
  [storyId: string]: number;
}

interface ChapterData {
  chapter: number;
  content: string;
  timestamp: number;
}

interface TimeStats {
  startTime: number;
  totalScraped: number;
  totalChapters: number;
  lastUpdateTime: number;
  recentChapters: Array<{ chapter: number; timestamp: number }>;
}

interface BrowserPool {
  browser: Browser;
  pages: Page[];
  inUse: boolean[];
}

class UltraFastScraper {
  private browserPools: BrowserPool[] = [];
  private isShuttingDown = false;
  private timeStats: TimeStats = {
    startTime: 0,
    totalScraped: 0,
    totalChapters: 1384, // Sẽ được cập nhật
    lastUpdateTime: 0,
    recentChapters: [],
  };
  private progressInterval: NodeJS.Timeout | null = null;
  private memoryCache: Map<number, ChapterData> = new Map();
  private batchWriteBuffer: ChapterData[] = [];
  private currentScrapingBaseUrl: string | null = null;
  private _scrapedThisSessionCount = 0;

  // Biến thành viên để lưu trữ cấu hình động
  private connectionPoolSize: number = DEFAULT_CONNECTION_POOL_SIZE;
  private pagePoolSize: number = DEFAULT_PAGE_POOL_SIZE;

  constructor() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    process.on("SIGINT", this.gracefulShutdown.bind(this));
    process.on("SIGTERM", this.gracefulShutdown.bind(this));
    process.on("uncaughtException", this.handleError.bind(this));
    process.on("unhandledRejection", this.handleError.bind(this));

    if (global.gc) {
      setInterval(() => {
        if (typeof global.gc === "function") {
          global.gc();
        }
      }, 30000);
    }
  }

  private async gracefulShutdown(): Promise<void> {
    console.log("\n🔄 Đang thoát an toàn và lưu dữ liệu...");
    this.isShuttingDown = true;

    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }

    await this.flushBatchBuffer();

    for (const pool of this.browserPools) {
      if (pool && pool.browser) {
        try {
          await pool.browser.close();
        } catch (error) {
          console.warn("Lỗi khi đóng browser pool:", error);
        }
      }
    }
    this.browserPools = [];

    this.displayFinalStats();
    console.log("✅ Đã thoát an toàn");
    setTimeout(() => process.exit(0), 1000);
  }

  private handleError(error: any): void {
    console.error("❌ Lỗi không mong muốn:", error);
    this.isShuttingDown = true;
  }

  private async initializeBrowserPools(): Promise<void> {
    // Sử dụng biến thành viên thay vì hằng số
    console.log(
      `🚀 Khởi tạo ${this.connectionPoolSize} browser pools với ${this.pagePoolSize} pages mỗi pool...`
    );

    for (let i = 0; i < this.connectionPoolSize; i++) {
      if (this.isShuttingDown) break;
      try {
        const browser = await this.createOptimizedBrowser(true, i);
        const pages: Page[] = [];
        const inUse: boolean[] = new Array(this.pagePoolSize).fill(false);

        for (let j = 0; j < this.pagePoolSize; j++) {
          if (this.isShuttingDown) break;
          const page = await browser.newPage();
          await this.optimizePageForSpeed(page);
          pages.push(page);
          try {
            await page.goto("about:blank", { timeout: 10000 });
          } catch (warmUpError) {
            console.warn(
              `⚠️ Lỗi warm-up page ${i}-${j}:`,
              (warmUpError as Error).message
            );
          }
        }
        if (!this.isShuttingDown) {
          this.browserPools.push({ browser, pages, inUse });
          console.log(
            `✅ Browser pool ${i + 1} sẵn sàng với ${pages.length} pages.`
          );
        } else {
          await browser.close();
          console.log(`🔶 Browser pool ${i + 1} đã bị hủy do yêu cầu tắt.`);
          break;
        }
      } catch (browserInitError) {
        console.error(
          `❌ Lỗi khởi tạo browser pool ${i + 1}:`,
          (browserInitError as Error).message
        );
      }
    }

    if (
      this.browserPools.length === 0 &&
      this.connectionPoolSize > 0 &&
      !this.isShuttingDown
    ) {
      console.error(
        "❌ Không thể khởi tạo bất kỳ browser pool nào. Kiểm tra cấu hình Puppeteer, đường dẫn Chrome và tài nguyên hệ thống."
      );
      return;
    }

    const totalPagesReady = this.browserPools.reduce(
      (sum, pool) => sum + pool.pages.length,
      0
    );
    console.log(`🎯 Tổng cộng ${totalPagesReady} pages sẵn sàng!`);
  }

  private async getAvailablePage(): Promise<{
    page: Page;
    poolIndex: number;
    pageIndex: number;
  } | null> {
    for (let i = 0; i < this.browserPools.length; i++) {
      const pool = this.browserPools[i];
      if (!pool || !pool.pages || pool.pages.length === 0) continue;

      const availablePageIndex = pool.inUse.indexOf(false);
      if (availablePageIndex !== -1) {
        pool.inUse[availablePageIndex] = true;
        return {
          page: pool.pages[availablePageIndex],
          poolIndex: i,
          pageIndex: availablePageIndex,
        };
      }
    }
    return null;
  }

  private releasePage(poolIndex: number, pageIndex: number): void {
    if (
      this.browserPools[poolIndex] &&
      this.browserPools[poolIndex].inUse &&
      this.browserPools[poolIndex].inUse[pageIndex] !== undefined
    ) {
      this.browserPools[poolIndex].inUse[pageIndex] = false;
    }
  }

  private async addToBatchBuffer(chapterData: ChapterData): Promise<void> {
    this.batchWriteBuffer.push(chapterData);
    this.memoryCache.set(chapterData.chapter, chapterData);

    if (this.batchWriteBuffer.length >= BATCH_SIZE) {
      await this.flushBatchBuffer();
    }
  }

  private async flushBatchBuffer(): Promise<void> {
    if (this.batchWriteBuffer.length === 0) return;

    const dataToWrite = [...this.batchWriteBuffer];
    this.batchWriteBuffer = [];

    setImmediate(async () => {
      try {
        const storyIdForFile =
          this.getStoryIdFromUrl(this.currentScrapingBaseUrl || "default") ||
          "unknown_story";
        await this.appendChaptersToFile(storyIdForFile, dataToWrite);
      } catch (error) {
        console.error("❌ Lỗi khi flush batch buffer (ghi file):", error);
      }
    });
  }

  private async appendChaptersToFile(
    storyFileName: string,
    newChapters: ChapterData[]
  ): Promise<void> {
    const outputPath = path.join(DATA_DIR, `${storyFileName}.json`);
    try {
      let existingData: ChapterData[] = [];
      if (fs.existsSync(outputPath)) {
        const content = await fs.promises.readFile(outputPath, "utf-8");
        if (content) {
          try {
            existingData = JSON.parse(content);
            if (!Array.isArray(existingData)) {
              console.warn(
                `⚠️ Dữ liệu trong ${outputPath} không phải là mảng. Tạo file mới.`
              );
              existingData = [];
            }
          } catch (parseError) {
            console.warn(
              `⚠️ Lỗi parse JSON từ file ${outputPath}, file có thể bị hỏng. Tạo file mới.`,
              parseError
            );
            existingData = [];
          }
        }
      }

      const chapterMap = new Map<number, ChapterData>();
      existingData.forEach((chapter) =>
        chapterMap.set(chapter.chapter, chapter)
      );
      newChapters.forEach((chapter) =>
        chapterMap.set(chapter.chapter, chapter)
      );

      const sortedData = Array.from(chapterMap.values()).sort(
        (a, b) => a.chapter - b.chapter
      );
      await fs.promises.writeFile(
        outputPath,
        JSON.stringify(sortedData, null, 1)
      );
    } catch (error) {
      console.error(`❌ Lỗi khi ghi file ${outputPath}:`, error);
    }
  }

  private async readProgress(): Promise<Progress> {
    try {
      if (fs.existsSync(PROGRESS_FILE)) {
        const content = await fs.promises.readFile(PROGRESS_FILE, "utf-8");
        if (content) return JSON.parse(content);
      }
    } catch (error) {
      console.warn("⚠️ Không thể đọc file progress, tạo mới:", error);
    }
    return {};
  }

  private async saveProgress(progress: Progress): Promise<void> {
    try {
      setImmediate(async () => {
        await fs.promises.writeFile(
          PROGRESS_FILE,
          JSON.stringify(progress, null, 2)
        );
      });
    } catch (error) {
      console.error("❌ Lỗi khi lưu progress:", error);
    }
  }

  private async scrapeChapterUltraFast(
    chapterNum: number,
    baseUrl: string
  ): Promise<ChapterData | null> {
    const maxAttempts = RETRY_LIMIT;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.isShuttingDown) return null;

      let pageInfo = await this.getAvailablePage();
      if (!pageInfo) {
        await this.delay(250 + attempt * 100);
        pageInfo = await this.getAvailablePage();
        if (!pageInfo) {
          if (attempt === maxAttempts - 1)
            console.warn(
              `⚠️ Không có page nào sẵn sàng sau nhiều lần chờ để cào chương ${chapterNum}.`
            );
          continue;
        }
      }

      const { page, poolIndex, pageIndex } = pageInfo;

      try {
        const chapterUrl = `${baseUrl}/chapter/${chapterNum}`;
        await page.goto(chapterUrl, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });

        const chapterContent = await page.evaluate(() => {
          const selectors = [
            ".text-lg.leading-relaxed.whitespace-pre-line.text-justify",
            "#chapter-content", // ID thường ưu tiên hơn class
            ".reading-content .text-base", // Selector cụ thể hơn
            ".content-story",
            "div[class*='chapter_content']", // Tìm class chứa "chapter_content"
            "div[id*='chapter_content']", // Tìm id chứa "chapter_content"
            "article.chapter-content",
            "#content",
            "main .content", // Thêm các selector có thể có
            ".prose", // Thường dùng cho nội dung bài viết
          ];
          for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (
              element &&
              element.textContent &&
              element.textContent.trim().length > 10
            ) {
              // Xóa các thẻ <script>, <style>, comments và các thẻ quảng cáo nếu có
              element
                .querySelectorAll(
                  'script, style, ins, [class*="ads"], [id*="ads"], form, button, input, iframe, noscript, .hidden, [style*="display:none"], [style*="display: none"]'
                )
                .forEach((el) => el.remove());
              // Lấy textContent sau khi đã xóa
              let text = element.textContent?.trim() || "";
              // Thay thế nhiều xuống dòng liên tiếp bằng một xuống dòng
              text = text.replace(/\n\s*\n/g, "\n");
              return text;
            }
          }
          return ""; // Trả về rỗng nếu không tìm thấy selector nào phù hợp
        });

        this.releasePage(poolIndex, pageIndex);

        if (chapterContent && chapterContent.length > 50) {
          // Yêu cầu độ dài tối thiểu
          this.countScrapedThisSession(); // Đếm chương cào thành công
          return {
            chapter: chapterNum,
            content: chapterContent,
            timestamp: Date.now(),
          };
        } else if (chapterContent) {
          // console.warn(`⚠️ Nội dung chương ${chapterNum} quá ngắn (${chapterContent.length} ký tự). URL: ${chapterUrl}`);
          return null;
        } else {
          // console.warn(`⚠️ Không tìm thấy nội dung cho chương ${chapterNum}. URL: ${chapterUrl}`);
          return null;
        }
      } catch (error: any) {
        lastError = error;
        this.releasePage(poolIndex, pageIndex);
        if (this.isShuttingDown) return null;
        if (attempt < maxAttempts - 1) {
          await this.delay(300 * (attempt + 1) + DELAY_BETWEEN_REQUESTS);
        }
      }
    }
    return null;
  }

  // Cập nhật phương thức scrapeStory để nhận các tham số mới
  async scrapeStory(
    baseUrl: string,
    numInstances: number = DEFAULT_CONNECTION_POOL_SIZE,
    numPagesPerInstance: number = DEFAULT_PAGE_POOL_SIZE,
    totalChaptersInput?: number
  ): Promise<void> {
    this.currentScrapingBaseUrl = baseUrl;
    // Gán giá trị từ tham số cho biến thành viên
    this.connectionPoolSize =
      numInstances > 0 ? numInstances : DEFAULT_CONNECTION_POOL_SIZE;
    this.pagePoolSize =
      numPagesPerInstance > 0 ? numPagesPerInstance : DEFAULT_PAGE_POOL_SIZE;
    this._scrapedThisSessionCount = 0; // Reset bộ đếm cho phiên mới

    const storyId = this.getStoryIdFromUrl(baseUrl) || "default-story";
    const progress = await this.readProgress();
    let startChapter = progress[storyId] || 1;

    const totalChapters =
      totalChaptersInput ||
      this.timeStats.totalChapters ||
      MAX_CHAPTERS_TO_CHECK;
    this.timeStats.totalChapters = totalChapters;

    this.initializeTimeTracking(totalChapters, 0);

    let existingChaptersCount = 0;
    const storyFileName = this.getStoryIdFromUrl(baseUrl) || "unknown_story";
    const outputPath = path.join(DATA_DIR, `${storyFileName}.json`);

    if (fs.existsSync(outputPath)) {
      try {
        const content = await fs.promises.readFile(outputPath, "utf-8");
        if (content) {
          const existingData: ChapterData[] = JSON.parse(content);
          if (Array.isArray(existingData)) {
            existingChaptersCount = existingData.length;
            if (existingChaptersCount > 0) {
              const maxChapter = Math.max(
                ...existingData.map((c) => c.chapter),
                0
              );
              startChapter = Math.max(startChapter, maxChapter + 1);
            }
          }
        }
      } catch (error) {
        console.warn(`⚠️ Không thể đọc dữ liệu cũ từ ${outputPath}:`, error);
      }
    }
    this.timeStats.totalScraped = existingChaptersCount;
    if (existingChaptersCount > 0) {
      console.log(
        `📚 Đã có ${existingChaptersCount} chương. Tiếp tục từ chương ${startChapter}.`
      );
    }

    await this.initializeBrowserPools();
    if (this.browserPools.length === 0 && !this.isShuttingDown) {
      console.error(
        "❌ Không có browser pool nào được khởi tạo. Dừng cào dữ liệu."
      );
      return;
    }
    if (this.isShuttingDown) {
      console.log("🔶 Quá trình cào bị hủy trước khi bắt đầu worker.");
      return;
    }

    const chapterQueue: number[] = [];
    const chaptersToScrapeCount = totalChapters - startChapter + 1;

    for (
      let i = 0;
      i < Math.min(MAX_CHAPTERS_TO_CHECK, chaptersToScrapeCount);
      i++
    ) {
      if (startChapter + i <= totalChapters) {
        chapterQueue.push(startChapter + i);
      }
    }

    if (
      chapterQueue.length === 0 &&
      startChapter > totalChapters &&
      existingChaptersCount >= totalChapters
    ) {
      console.log("✅ Tất cả các chương đã được cào trước đó.");
      this.displayFinalStats();
      return;
    }
    if (chapterQueue.length === 0) {
      console.log(
        `🧐 Không có chương mới nào để cào (từ ${startChapter} đến ${totalChapters}). Có thể đã cào đủ hoặc tổng số chương không chính xác.`
      );
      this.displayFinalStats();
      return;
    }

    console.log(
      `🚀 Bắt đầu cào ${chapterQueue.length} chương (từ ${
        chapterQueue[0]
      } đến ${
        chapterQueue[chapterQueue.length - 1]
      }) với ${CONCURRENCY_LIMIT} luồng song song.`
    );

    const workers: Promise<void>[] = [];
    let consecutiveFailures = 0;
    let shouldStopScraping = false;

    this.progressInterval = setInterval(() => {
      if (!this.isShuttingDown) this.displayLiveProgress();
    }, 5000);

    const totalAvailablePages = this.browserPools.reduce(
      (acc, pool) => acc + pool.pages.length,
      0
    );
    const effectiveConcurrency = Math.min(
      CONCURRENCY_LIMIT,
      totalAvailablePages
    );

    if (effectiveConcurrency === 0 && chapterQueue.length > 0) {
      console.error("❌ Không có page nào sẵn sàng để cào dữ liệu. Dừng lại.");
      if (this.progressInterval) clearInterval(this.progressInterval);
      this.displayFinalStats();
      return;
    }

    if (effectiveConcurrency < CONCURRENCY_LIMIT && chapterQueue.length > 0) {
      console.warn(
        `⚠️ Số luồng hiệu dụng (${effectiveConcurrency}) thấp hơn cấu hình (${CONCURRENCY_LIMIT}) do số page sẵn có ít hơn.`
      );
    }

    for (let workerId = 0; workerId < effectiveConcurrency; workerId++) {
      workers.push(
        (async () => {
          while (
            chapterQueue.length > 0 &&
            !shouldStopScraping &&
            !this.isShuttingDown
          ) {
            const chapterNum = chapterQueue.shift();
            if (chapterNum === undefined) break;

            try {
              const result = await this.scrapeChapterUltraFast(
                chapterNum,
                baseUrl
              );

              if (result) {
                // this.countScrapedThisSession() đã được gọi trong scrapeChapterUltraFast
                await this.addToBatchBuffer(result);
                this.updateTimeStats(chapterNum); // Cập nhật cho recentChapters
                progress[storyId] = chapterNum;
                await this.saveProgress(progress);
                consecutiveFailures = 0;

                if (this._scrapedThisSessionCount % 20 === 0) {
                  this.displayQuickProgress(chapterNum);
                }
              } else {
                consecutiveFailures++;
                if (consecutiveFailures > 40 && chapterQueue.length > 20) {
                  console.log(
                    `🔚 Quá nhiều chương không có nội dung hoặc lỗi liên tiếp (${consecutiveFailures} lần). Dừng cào sớm.`
                  );
                  shouldStopScraping = true;
                }
              }
              if (!this.isShuttingDown)
                await this.delay(DELAY_BETWEEN_REQUESTS + Math.random() * 50);
            } catch (error: any) {
              console.error(
                `❌ Worker ${workerId} - Chương ${chapterNum} gặp lỗi nghiêm trọng: ${
                  error.message.split("\n")[0]
                }`
              );
              consecutiveFailures++;
            }
          }
        })()
      );
    }

    await Promise.all(workers);

    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }
    await this.flushBatchBuffer();

    for (const pool of this.browserPools) {
      if (pool && pool.browser) {
        try {
          await pool.browser.close();
        } catch (closeError) {
          console.warn(
            "Lỗi khi đóng browser instance trong pool (sau khi worker xong):",
            closeError
          );
        }
      }
    }
    this.browserPools = [];

    this.displayFinalStats();
    console.log(
      `🎉 Hoàn thành! Tổng cộng ${this.timeStats.totalScraped} chương đã được xử lý (bao gồm cả các chương đã có từ trước).`
    );
    if (this.isShuttingDown && !shouldStopScraping) {
      console.log(
        "🔶 Quá trình cào đã bị dừng bởi người dùng (SIGINT/SIGTERM)."
      );
    }
  }

  private async createOptimizedBrowser(
    headless: boolean = false,
    instanceIndex?: number
  ): Promise<Browser> {
    let profileSubDir = headless ? "headless_profile" : "login_profile";
    if (headless && instanceIndex !== undefined) {
      profileSubDir = `headless_profile_${instanceIndex}`;
    }
    const userDataDir = path.join(process.cwd(), "chrome-data", profileSubDir);

    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    const chromePath =
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    let executablePathToUse: string | undefined = undefined;

    if (fs.existsSync(chromePath)) {
      executablePathToUse = chromePath;
    } else {
      const alternativeChromePath =
        "C:\\Users\\duoc6\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"; // Đường dẫn của bạn
      if (fs.existsSync(alternativeChromePath)) {
        executablePathToUse = alternativeChromePath;
        // console.warn(`⚠️ Sử dụng đường dẫn Chrome thay thế: ${alternativeChromePath}`); // Đã log ở lần trước
      } else {
        console.error(
          `❌ Đường dẫn Chrome không hợp lệ: ${chromePath} và ${alternativeChromePath} đều không tìm thấy.`
        );
        console.warn("⚠️ Thử để Puppeteer tự tìm Chrome...");
      }
    }

    const baseArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-infobars",
      "--window-size=1366,768",
      "--lang=vi-VN,vi,en-US,en",
      "--no-default-browser-check",
      "--no-first-run",
      "--disable-popup-blocking",
    ];

    let specificArgs: string[] = [];

    if (headless) {
      specificArgs = [
        ...baseArgs,
        "--disable-gpu",
        "--disable-extensions",
        "--disable-accelerated-2d-canvas",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-ipc-flooding-protection",
        "--disable-blink-features=AutomationControlled",
        "--disable-site-isolation-trials",
        "--memory-pressure-off",
        "--disable-background-networking",
        "--disable-client-side-phishing-detection",
        "--disable-default-apps",
        "--disable-hang-monitor",
        "--disable-prompt-on-repost",
        "--disable-sync",
        "--metrics-recording-only",
        "--safebrowsing-disable-auto-update",
        "--password-store=basic",
        "--use-mock-keychain",
        "--disable-logging",
        "--disable-breakpad",
        "--disable-plugins",
        "--disable-plugins-discovery",
        "--disable-preconnect",
        "--disable-translate",
        "--hide-scrollbars",
        "--mute-audio",
        "--no-pings",
        "--no-zygote",
      ];
    } else {
      specificArgs = [...baseArgs];
    }

    const launchOptions: LaunchOptions = {
      headless: headless,
      executablePath: executablePathToUse,
      userDataDir: userDataDir,
      args: specificArgs,
      ignoreDefaultArgs: ["--enable-automation"],
      defaultViewport: null,
    };

    return await puppeteer.launch(launchOptions);
  }

  private async optimizePageForSpeed(page: Page): Promise<void> {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      // Nới lỏng hơn: cho phép css và font để trang hiển thị đúng hơn, có thể cần cho một số trang
      // Nếu vẫn lỗi, có thể thử cho phép 'image'
      if (
        ["document", "script", "xhr", "fetch", "stylesheet", "font"].includes(
          resourceType
        )
      ) {
        req.continue();
      } else {
        req.abort();
      }
    });

    await page.setViewport({ width: 1280, height: 800 }); // Viewport lớn hơn một chút
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36" // User agent gần đây
    );

    page.setDefaultNavigationTimeout(30000); // Tăng timeout điều hướng
    page.setDefaultTimeout(25000);

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", {
        get: () => ["vi-VN", "vi", "en-US", "en"],
      });
      try {
        const style = document.createElement("style");
        style.innerHTML = `
          *, *::before, *::after {
            animation-duration: 0.001s !important;
            animation-delay: 0s !important;
            transition-duration: 0.001s !important;
            transition-delay: 0s !important;
            scroll-behavior: auto !important;
          }`;
        document.documentElement.appendChild(style);
      } catch (e) {
        /* ignore */
      }
    });
  }

  private initializeTimeTracking(
    totalChapters: number,
    existingChapters: number = 0
  ): void {
    this.timeStats = {
      startTime: Date.now(),
      totalScraped: existingChapters,
      totalChapters: totalChapters,
      lastUpdateTime: Date.now(),
      recentChapters: [],
    };
    console.log(
      `\n🚀 ============ ULTRA-FAST SCRAPER V2.1 (Configurable) ============`
    );
    console.log(`📊 Tổng số chương dự kiến: ${totalChapters}`);
    if (existingChapters > 0) {
      console.log(`📚 Đã có sẵn: ${existingChapters} chương`);
      console.log(
        `🎯 Cần cào thêm: ${Math.max(
          0,
          totalChapters - existingChapters
        )} chương`
      );
    }
    console.log(`⚡ Chế độ: ULTRA HIGH SPEED`);
    // Sử dụng biến thành viên đã được thiết lập
    console.log(
      `🔥 Browser Instances: ${this.connectionPoolSize} | Pages/Instance: ${this.pagePoolSize}`
    );
    console.log(
      `⚙️ Luồng cào đồng thời (ước tính): ${Math.min(
        CONCURRENCY_LIMIT,
        this.connectionPoolSize * this.pagePoolSize
      )}`
    );
    console.log(
      `⏰ Bắt đầu lúc: ${new Date(this.timeStats.startTime).toLocaleString(
        "vi-VN"
      )}`
    );
    console.log(
      `==================================================================\n`
    );
  }

  private updateTimeStats(chapterNum: number): void {
    const now = Date.now();
    // totalScraped đã được tăng bởi countScrapedThisSession()
    this.timeStats.lastUpdateTime = now;
    this.timeStats.recentChapters.push({ chapter: chapterNum, timestamp: now });
    if (this.timeStats.recentChapters.length > 50) {
      this.timeStats.recentChapters.shift();
    }
  }

  private countScrapedThisSession() {
    this._scrapedThisSessionCount++;
    this.timeStats.totalScraped++;
  }

  private calculateCurrentSpeed(): {
    current: number;
    averageThisSession: number;
  } {
    const now = Date.now();
    const elapsedSinceStartThisSession = now - this.timeStats.startTime;

    const averageSpeedThisSession =
      elapsedSinceStartThisSession > 0 && this._scrapedThisSessionCount > 0
        ? (this._scrapedThisSessionCount / elapsedSinceStartThisSession) *
          3600000
        : 0;

    let currentSpeed = 0;
    if (this.timeStats.recentChapters.length >= 2) {
      const firstRecent = this.timeStats.recentChapters[0];
      const lastRecent =
        this.timeStats.recentChapters[this.timeStats.recentChapters.length - 1];
      const recentElapsed = lastRecent.timestamp - firstRecent.timestamp;
      const recentScrapedCount = this.timeStats.recentChapters.length - 1;

      if (recentElapsed > 0 && recentScrapedCount > 0) {
        currentSpeed = (recentScrapedCount / recentElapsed) * 3600000;
      } else {
        currentSpeed = averageSpeedThisSession;
      }
    } else {
      currentSpeed = averageSpeedThisSession;
    }

    return {
      current: isNaN(currentSpeed) ? 0 : currentSpeed,
      averageThisSession: isNaN(averageSpeedThisSession)
        ? 0
        : averageSpeedThisSession,
    };
  }

  private calculateETA(): {
    etaTime: string;
    etaFormatted: string;
    remainingMs: number;
  } {
    const remainingChapters =
      this.timeStats.totalChapters - this.timeStats.totalScraped;
    if (remainingChapters <= 0) {
      return { etaTime: "Hoàn thành", etaFormatted: "0s", remainingMs: 0 };
    }

    const speed = this.calculateCurrentSpeed();
    const effectiveSpeedPerHour =
      speed.current > 10 ? speed.current : speed.averageThisSession;

    if (effectiveSpeedPerHour <= 0) {
      return {
        etaTime: "Calculating...",
        etaFormatted: "Calculating...",
        remainingMs: Infinity,
      };
    }

    const remainingHours = remainingChapters / effectiveSpeedPerHour;
    const remainingMs = remainingHours * 3600000;
    const finishTime = new Date(Date.now() + remainingMs);

    return {
      etaTime: finishTime.toLocaleString("vi-VN"),
      etaFormatted: this.formatTime(remainingMs),
      remainingMs: remainingMs,
    };
  }

  private formatTime(ms: number): string {
    if (!isFinite(ms) || isNaN(ms) || ms < 0) return "Calculating...";
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    let result = "";
    if (days > 0) result += `${days}d `;
    if (hours > 0 || (days > 0 && (minutes > 0 || seconds > 0)))
      result += `${hours}h `;
    if (minutes > 0 || ((days > 0 || hours > 0) && seconds > 0))
      result += `${minutes}m `;
    result += `${seconds}s`;

    return result.trim() || "0s";
  }

  private displayQuickProgress(chapterNum: number): void {
    const percent = Math.min(
      100,
      (this.timeStats.totalScraped / this.timeStats.totalChapters) * 100
    ).toFixed(1);
    const speed = this.calculateCurrentSpeed();
    console.log(
      `⚡ C${chapterNum} | ${this.timeStats.totalScraped}/${
        this.timeStats.totalChapters
      } (${percent}%) | ${speed.current.toFixed(
        1
      )} ch/h (TB phiên: ${speed.averageThisSession.toFixed(1)} ch/h)`
    );
  }

  private displayLiveProgress(): void {
    if (this.timeStats.startTime === 0) return;

    const now = Date.now();
    const elapsed = now - this.timeStats.startTime;
    const eta = this.calculateETA();
    const speed = this.calculateCurrentSpeed();

    console.log(
      `\n📊============ PROGRESS (${new Date().toLocaleTimeString(
        "vi-VN"
      )}) ============📊`
    );
    const progressPercent = Math.min(
      100,
      (this.timeStats.totalScraped / this.timeStats.totalChapters) * 100
    ).toFixed(1);
    console.log(
      ` Truyện: ${
        this.getStoryIdFromUrl(this.currentScrapingBaseUrl || "") || "N/A"
      }`
    );
    console.log(
      ` Đã cào: ${this.timeStats.totalScraped} / ${this.timeStats.totalChapters} (${progressPercent}%)`
    );
    console.log(` Chương cào trong phiên: ${this._scrapedThisSessionCount}`);
    console.log(` Đã chạy: ${this.formatTime(elapsed)}`);
    if (this.timeStats.totalScraped < this.timeStats.totalChapters) {
      console.log(` Còn lại: ${eta.etaFormatted} (ETA: ${eta.etaTime})`);
    } else {
      console.log(` Còn lại: Hoàn thành!`);
    }
    console.log(` Tốc độ hiện tại: ${speed.current.toFixed(1)} ch/h`);
    console.log(
      ` Tốc độ TB phiên: ${speed.averageThisSession.toFixed(1)} ch/h`
    );
    console.log(` Buffer ghi: ${this.batchWriteBuffer.length} chapters`);
    console.log(`======================================================\n`);
  }

  private displayFinalStats(): void {
    const now = Date.now();
    const totalTime = Math.max(0, now - this.timeStats.startTime);
    const speed = this.calculateCurrentSpeed();

    console.log(`\n🏆 ========== FINAL STATS ========== 🏆`);
    console.log(
      ` Truyện: ${
        this.getStoryIdFromUrl(this.currentScrapingBaseUrl || "") || "N/A"
      }`
    );
    console.log(
      ` Tổng số chương đã xử lý (bao gồm cũ): ${this.timeStats.totalScraped}`
    );
    console.log(
      ` Số chương cào trong phiên này: ${this._scrapedThisSessionCount}`
    );
    console.log(
      ` Tổng thời gian chạy phiên này: ${this.formatTime(totalTime)}`
    );

    const finalAverageSpeedThisSession = speed.averageThisSession;
    console.log(
      ` Tốc độ trung bình (phiên này): ${finalAverageSpeedThisSession.toFixed(
        1
      )} chương/giờ`
    );

    if (this._scrapedThisSessionCount > 0 && totalTime > 0) {
      console.log(
        ` Thời gian/chương (phiên này): ${(
          totalTime /
          this._scrapedThisSessionCount /
          1000
        ).toFixed(2)}s`
      );
    }
    console.log(` Hoàn thành lúc: ${new Date(now).toLocaleString("vi-VN")}`);
    if (this.timeStats.totalChapters > 0) {
      const efficiency = Math.min(
        100,
        (this.timeStats.totalScraped / this.timeStats.totalChapters) * 100
      ).toFixed(1);
      console.log(
        ` Hoàn thành truyện: ${efficiency}% (so với ${this.timeStats.totalChapters} chương dự kiến)`
      );
    }
    console.log(`=====================================\n`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getStoryIdFromUrl(url: string): string {
    if (!url) return "unknown_story_no_url";
    try {
      const urlObj = new URL(url);
      const pathSegments = urlObj.pathname.split("/").filter(Boolean);
      const novelIndex = pathSegments.findIndex(
        (seg) => seg === "novel" || seg === "story" || seg === "truyen"
      );
      if (novelIndex > -1 && pathSegments.length > novelIndex + 1) {
        return pathSegments[novelIndex + 1]
          .replace(/[^a-zA-Z0-9-_]/g, "_")
          .toLowerCase();
      }
      if (pathSegments.length > 0) {
        return pathSegments[pathSegments.length - 1]
          .replace(/[^a-zA-Z0-9-_]/g, "_")
          .toLowerCase();
      }
      return urlObj.hostname.replace(/[^a-zA-Z0-9-_]/g, "_").toLowerCase();
    } catch (error) {
      return url
        .replace(/[^a-zA-Z0-9-_./:]/g, "")
        .replace(/[\/.:]/g, "_")
        .toLowerCase();
    }
  }

  async openLoginBrowser(): Promise<void> {
    console.log("🌐 Mở trình duyệt để đăng nhập...");
    let manualBrowser: Browser | null = null;
    try {
      manualBrowser = await this.createOptimizedBrowser(false);
      const manualPage = await manualBrowser.newPage();

      console.log(
        "Điều hướng đến trang đăng nhập (https://truyen25h.com/login)..."
      );
      await manualPage.goto("https://truyen25h.com/login", {
        waitUntil: "networkidle2",
        timeout: 60000,
      });

      console.log(
        "✅ Trình duyệt đã mở. Vui lòng đăng nhập thủ công vào trang web."
      );
      console.log(
        "💡 Sau khi đăng nhập thành công, bạn có thể đóng cửa sổ trình duyệt này."
      );
      console.log(
        "🔑 Session đăng nhập sẽ được lưu trong thư mục 'chrome-data/login_profile'."
      );
      console.log(
        "🔄 Sau đó, bạn có thể chạy lại tiến trình cào dữ liệu chính (ví dụ: npx ts-node src/index.ts)."
      );

      await new Promise((resolve) =>
        manualBrowser?.on("disconnected", resolve)
      );
      console.log("🔒 Trình duyệt đăng nhập đã được đóng.");
    } catch (error) {
      console.error("❌ Có lỗi xảy ra khi mở trình duyệt đăng nhập:", error);
      if (manualBrowser) {
        try {
          await manualBrowser.close();
        } catch (closeError) {
          console.error(
            "Lỗi khi đóng trình duyệt đăng nhập sau khi gặp lỗi:",
            closeError
          );
        }
      }
    }
  }
}

export default new UltraFastScraper();
