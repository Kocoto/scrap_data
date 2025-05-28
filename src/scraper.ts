import puppeteer, { Browser, Page } from "puppeteer-core";
import * as fs from "fs";
import * as path from "path";
import { Worker } from "worker_threads";

const PROGRESS_FILE = "progress.json";
const DATA_DIR = "data";
const CONCURRENCY_LIMIT = 8; // Tăng lên 8 concurrent connections
const MAX_CHAPTERS_TO_CHECK = 5000;
const SAVE_INTERVAL = 20; // Lưu dữ liệu mỗi 20 chương để giảm I/O
const RETRY_LIMIT = 2; // Giảm retry để tăng tốc
const DELAY_BETWEEN_REQUESTS = 200; // Giảm delay xuống 200ms
const BATCH_SIZE = 50; // Xử lý theo batch
const CONNECTION_POOL_SIZE = 3; // Số browser instances
const PAGE_POOL_SIZE = 10; // Số pages per browser

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
    totalChapters: 1384,
    lastUpdateTime: 0,
    recentChapters: [],
  };
  private progressInterval: NodeJS.Timeout | null = null;
  private memoryCache: Map<number, ChapterData> = new Map();
  private batchWriteBuffer: ChapterData[] = [];

  constructor() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Optimized process handlers
    process.on("SIGINT", this.gracefulShutdown.bind(this));
    process.on("SIGTERM", this.gracefulShutdown.bind(this));
    process.on("uncaughtException", this.handleError.bind(this));
    process.on("unhandledRejection", this.handleError.bind(this));

    // Memory optimization
    if (global.gc) {
      setInterval(() => {
        if (typeof global.gc === "function") {
          global.gc();
        }
      }, 30000); // GC every 30 seconds
    }
  }

  private async gracefulShutdown() {
    console.log("\n🔄 Đang thoát an toàn và lưu dữ liệu...");
    this.isShuttingDown = true;

    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }

    // Flush remaining data
    await this.flushBatchBuffer();

    // Close all browser pools
    for (const pool of this.browserPools) {
      try {
        await pool.browser.close();
      } catch (error) {
        console.warn("Lỗi khi đóng browser pool:", error);
      }
    }

    this.displayFinalStats();
    console.log("✅ Đã thoát an toàn");
    process.exit(0);
  }

  private handleError(error: any) {
    console.error("❌ Lỗi không mong muốn:", error);
    this.gracefulShutdown();
  }

  // Initialize browser pools for maximum performance
  private async initializeBrowserPools(): Promise<void> {
    console.log(
      `🚀 Khởi tạo ${CONNECTION_POOL_SIZE} browser pools với ${PAGE_POOL_SIZE} pages mỗi pool...`
    );

    for (let i = 0; i < CONNECTION_POOL_SIZE; i++) {
      const browser = await this.createOptimizedBrowser();
      const pages: Page[] = [];
      const inUse: boolean[] = [];

      // Pre-create pages
      for (let j = 0; j < PAGE_POOL_SIZE; j++) {
        const page = await browser.newPage();
        await this.optimizePageForSpeed(page);
        pages.push(page);
        inUse.push(false);

        // Warm up pages
        try {
          await page.goto("about:blank");
        } catch (error) {
          console.warn(`⚠️ Lỗi warm-up page ${i}-${j}:`, error);
        }
      }

      this.browserPools.push({ browser, pages, inUse });
      console.log(
        `✅ Browser pool ${i + 1} sẵn sàng với ${pages.length} pages`
      );
    }

    console.log(
      `🎯 Tổng cộng ${
        this.browserPools.length * PAGE_POOL_SIZE
      } pages sẵn sàng!`
    );
  }

  // Get available page from pool
  private async getAvailablePage(): Promise<{
    page: Page;
    poolIndex: number;
    pageIndex: number;
  } | null> {
    for (let poolIndex = 0; poolIndex < this.browserPools.length; poolIndex++) {
      const pool = this.browserPools[poolIndex];
      for (let pageIndex = 0; pageIndex < pool.pages.length; pageIndex++) {
        if (!pool.inUse[pageIndex]) {
          pool.inUse[pageIndex] = true;
          return { page: pool.pages[pageIndex], poolIndex, pageIndex };
        }
      }
    }
    return null;
  }

  // Release page back to pool
  private releasePage(poolIndex: number, pageIndex: number): void {
    if (this.browserPools[poolIndex]) {
      this.browserPools[poolIndex].inUse[pageIndex] = false;
    }
  }

  // Batch write optimization
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

    // Process in background to not block scraping
    setImmediate(async () => {
      try {
        // Group by story and write efficiently
        const groupedData = new Map<string, ChapterData[]>();
        for (const data of dataToWrite) {
          const key = "default"; // Assuming single story
          if (!groupedData.has(key)) {
            groupedData.set(key, []);
          }
          groupedData.get(key)!.push(data);
        }

        for (const [storyId, chapters] of groupedData) {
          await this.appendChaptersToFile(storyId, chapters);
        }
      } catch (error) {
        console.error("❌ Lỗi khi flush batch:", error);
      }
    });
  }

  private async appendChaptersToFile(
    storyId: string,
    chapters: ChapterData[]
  ): Promise<void> {
    const outputPath = path.join(DATA_DIR, `${storyId}.json`);

    try {
      let existingData: ChapterData[] = [];

      if (fs.existsSync(outputPath)) {
        const content = await fs.promises.readFile(outputPath, "utf-8");
        existingData = JSON.parse(content);
      }

      // Merge and deduplicate
      const chapterMap = new Map<number, ChapterData>();

      // Add existing chapters
      for (const chapter of existingData) {
        chapterMap.set(chapter.chapter, chapter);
      }

      // Add new chapters (will overwrite if duplicate)
      for (const chapter of chapters) {
        chapterMap.set(chapter.chapter, chapter);
      }

      // Sort and write
      const sortedData = Array.from(chapterMap.values()).sort(
        (a, b) => a.chapter - b.chapter
      );

      await fs.promises.writeFile(
        outputPath,
        JSON.stringify(sortedData, null, 1)
      ); // Compact JSON
    } catch (error) {
      console.error("❌ Lỗi khi ghi file:", error);
    }
  }

  private async readProgress(): Promise<Progress> {
    try {
      if (fs.existsSync(PROGRESS_FILE)) {
        const content = await fs.promises.readFile(PROGRESS_FILE, "utf-8");
        return JSON.parse(content);
      }
    } catch (error) {
      console.warn("⚠️ Không thể đọc file progress, tạo mới:", error);
    }
    return {};
  }

  private async saveProgress(progress: Progress): Promise<void> {
    try {
      // Non-blocking write
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

  // Ultra-fast chapter scraping with connection pooling
  private async scrapeChapterUltraFast(
    chapterNum: number,
    baseUrl: string
  ): Promise<ChapterData | null> {
    const maxAttempts = RETRY_LIMIT;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const pageInfo = await this.getAvailablePage();
      if (!pageInfo || this.isShuttingDown) {
        await this.delay(50); // Short wait before retry
        continue;
      }

      const { page, poolIndex, pageIndex } = pageInfo;

      try {
        const chapterUrl = `${baseUrl}/chapter/${chapterNum}`;

        // Ultra-fast navigation with minimal waiting
        await Promise.race([
          page.goto(chapterUrl, {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          }),
          this.delay(15000).then(() => {
            throw new Error("Navigation timeout");
          }),
        ]);

        // Fast content extraction with multiple selectors
        const chapterContent = await Promise.race([
          page.evaluate(() => {
            const selectors = [
              ".text-lg.leading-relaxed.whitespace-pre-line.text-justify",
              ".chapter-content",
              "[class*='content']",
              ".content",
            ];

            for (const selector of selectors) {
              const element = document.querySelector(selector);
              if (element && element.textContent) {
                return element.textContent.trim();
              }
            }
            return "";
          }),
          this.delay(10000).then(() => ""),
        ]);

        this.releasePage(poolIndex, pageIndex);

        if (chapterContent && chapterContent.length > 300) {
          // Reduced minimum length
          return {
            chapter: chapterNum,
            content: chapterContent,
            timestamp: Date.now(),
          };
        } else if (chapterContent.length === 0) {
          return null; // No content, likely end of chapters
        }
      } catch (error: any) {
        this.releasePage(poolIndex, pageIndex);
        lastError = error;

        if (attempt < maxAttempts - 1) {
          await this.delay(100 * (attempt + 1)); // Progressive backoff
        }
      }
    }

    return null;
  }

  async scrapeStory(
    baseUrl: string,
    totalChapters: number = 1384
  ): Promise<void> {
    const storyId = this.getStoryIdFromUrl(baseUrl);
    const progress = await this.readProgress();
    let startChapter = progress[storyId] || 1;

    // Initialize tracking
    this.initializeTimeTracking(totalChapters, 0);

    // Load existing data
    let existingChapters = 0;
    const outputPath = path.join(DATA_DIR, `${storyId}.json`);
    if (fs.existsSync(outputPath)) {
      try {
        const existingData = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
        existingChapters = existingData.length;

        if (existingChapters > 0) {
          const maxChapter = Math.max(
            ...existingData.map((c: any) => c.chapter)
          );
          startChapter = Math.max(startChapter, maxChapter + 1);
          this.timeStats.totalScraped = existingChapters;
          console.log(
            `📚 Đã có ${existingChapters} chương. Tiếp tục từ chương ${startChapter}`
          );
        }
      } catch (error) {
        console.warn(`⚠️ Không thể đọc dữ liệu cũ: ${error}`);
      }
    }

    // Initialize browser pools
    await this.initializeBrowserPools();

    // Create chapter queue
    const chapterQueue: number[] = [];
    for (
      let i = 0;
      i < Math.min(MAX_CHAPTERS_TO_CHECK, totalChapters - startChapter + 1);
      i++
    ) {
      chapterQueue.push(startChapter + i);
    }

    console.log(
      `🚀 Bắt đầu cào ${chapterQueue.length} chương với ${CONCURRENCY_LIMIT} luồng song song`
    );

    // Ultra-fast concurrent scraping
    const workers: Promise<void>[] = [];
    const chapterResults = new Map<number, ChapterData>();
    let consecutiveFailures = 0;
    let shouldStop = false;

    // Start progress monitoring
    this.progressInterval = setInterval(() => {
      this.displayLiveProgress();
    }, 5000); // Update every 5 seconds

    for (let workerId = 0; workerId < CONCURRENCY_LIMIT; workerId++) {
      workers.push(
        (async () => {
          while (
            chapterQueue.length > 0 &&
            !shouldStop &&
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
                chapterResults.set(chapterNum, result);
                await this.addToBatchBuffer(result);

                // Update progress
                this.updateTimeStats(chapterNum);
                progress[storyId] = chapterNum;
                await this.saveProgress(progress);

                consecutiveFailures = 0;

                // Quick progress display
                if (this.timeStats.totalScraped % 5 === 0) {
                  const percent = (
                    (this.timeStats.totalScraped / totalChapters) *
                    100
                  ).toFixed(1);
                  console.log(
                    `⚡ Chương ${chapterNum} | ${percent}% | ${this.calculateCurrentSpeed().current.toFixed(
                      1
                    )} ch/h`
                  );
                }
              } else {
                consecutiveFailures++;
                if (consecutiveFailures > 20) {
                  console.log(
                    `🔚 Nhiều chương trống liên tiếp, có thể đã hết nội dung`
                  );
                  shouldStop = true;
                  break;
                }
              }

              // Minimal delay for ultra-speed
              await this.delay(DELAY_BETWEEN_REQUESTS);
            } catch (error: any) {
              console.error(
                `❌ Worker ${workerId} - Chương ${chapterNum}: ${error.message}`
              );
              consecutiveFailures++;
            }
          }
        })()
      );
    }

    // Wait for all workers to complete
    await Promise.all(workers);

    // Final cleanup
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }

    await this.flushBatchBuffer();

    // Close browser pools
    for (const pool of this.browserPools) {
      await pool.browser.close();
    }
    this.browserPools = [];

    this.displayFinalStats();
    console.log(
      `🎉 Hoàn thành! Tổng cộng ${this.timeStats.totalScraped} chương`
    );
  }

  // Rest of the methods (createOptimizedBrowser, optimizePageForSpeed, etc.)
  private async createOptimizedBrowser(
    headless: boolean = true
  ): Promise<Browser> {
    const userDataDir = path.join(process.cwd(), "chrome-data");

    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    return await puppeteer.launch({
      headless: headless,
      executablePath:
        "C:\\Users\\duoc6\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      userDataDir: userDataDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=TranslateUI,VizDisplayCompositor",
        "--disable-ipc-flooding-protection",
        "--disable-web-security",
        "--disable-blink-features=AutomationControlled",
        "--disable-extensions",
        "--disable-infobars",
        "--window-size=1366,768",
        "--lang=vi-VN,vi,en-US,en",
        "--no-default-browser-check",
        "--no-first-run",
        "--disable-site-isolation-trials",
        "--memory-pressure-off",
        "--max_old_space_size=8192", // Increased memory limit
        "--disable-background-networking",
        "--disable-client-side-phishing-detection",
        "--disable-default-apps",
        "--disable-hang-monitor",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-sync",
        "--metrics-recording-only",
        "--safebrowsing-disable-auto-update",
        "--enable-automation",
        "--password-store=basic",
        "--use-mock-keychain",
        // Performance optimizations
        "--disable-logging",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--disable-dev-tools",
        "--disable-plugins",
        "--disable-plugins-discovery",
        "--disable-preconnect",
        "--disable-translate",
        "--hide-scrollbars",
        "--mute-audio",
        "--no-default-browser-check",
        "--no-pings",
        "--no-zygote",
        "--single-process", // Use with caution - may be unstable but faster
        "--disable-features=VizDisplayCompositor,AudioServiceOutOfProcess",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      defaultViewport: { width: 1366, height: 768 },
    });
  }

  private async optimizePageForSpeed(page: Page): Promise<void> {
    // Ultra-aggressive resource blocking
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      const url = req.url();

      // Block everything except documents and XHR
      if (resourceType === "document" || resourceType === "xhr") {
        req.continue();
      } else {
        req.abort();
      }
    });

    // Minimal viewport
    await page.setViewport({ width: 800, height: 600 });

    // Fast user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    );

    // Ultra-short timeouts
    page.setDefaultNavigationTimeout(15000);
    page.setDefaultTimeout(10000);

    // Maximum performance JS injection
    await page.evaluateOnNewDocument(() => {
      // Disable all animations and transitions
      const style = document.createElement("style");
      style.innerHTML = `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
          transform: none !important;
        }
        img, video, iframe { display: none !important; }
      `;

      const addStyle = () => {
        if (document.head) {
          document.head.appendChild(style);
        }
      };

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", addStyle);
      } else {
        addStyle();
      }

      // Disable all unnecessary features
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      window.console = window.console || {
        log() {},
        warn() {},
        error() {},
        info() {},
        debug() {},
      };

      // Override fetch and XHR to be faster
      const originalFetch = window.fetch;
      window.fetch = function (url, options) {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 8000); // 8s timeout
        return originalFetch(url, { ...options, signal: controller.signal });
      };
    });
  }

  // Time tracking methods (keeping existing implementations)
  private initializeTimeTracking(
    totalChapters: number = 1384,
    existingChapters: number = 0
  ): void {
    this.timeStats = {
      startTime: Date.now(),
      totalScraped: existingChapters,
      totalChapters: totalChapters,
      lastUpdateTime: Date.now(),
      recentChapters: [],
    };

    console.log(`\n🚀 ============ ULTRA-FAST SCRAPER ============`);
    console.log(`📊 Tổng số chương: ${totalChapters}`);
    console.log(`📚 Đã có sẵn: ${existingChapters} chương`);
    console.log(`🎯 Cần cào thêm: ${totalChapters - existingChapters} chương`);
    console.log(`⚡ Chế độ: ULTRA HIGH SPEED`);
    console.log(`🔥 Luồng song song: ${CONCURRENCY_LIMIT}`);
    console.log(
      `⏰ Bắt đầu lúc: ${new Date(this.timeStats.startTime).toLocaleString(
        "vi-VN"
      )}`
    );
    console.log(`===============================================\n`);
  }

  private updateTimeStats(chapterNum: number): void {
    const now = Date.now();
    this.timeStats.totalScraped++;
    this.timeStats.lastUpdateTime = now;

    // Keep recent chapters for speed calculation
    this.timeStats.recentChapters.push({ chapter: chapterNum, timestamp: now });
    if (this.timeStats.recentChapters.length > 50) {
      // Increased for better accuracy
      this.timeStats.recentChapters.shift();
    }
  }

  private calculateCurrentSpeed(): { current: number; average: number } {
    const now = Date.now();
    const elapsed = now - this.timeStats.startTime;
    const averageSpeed = (this.timeStats.totalScraped / elapsed) * 3600000;

    let currentSpeed = averageSpeed;
    if (this.timeStats.recentChapters.length >= 2) {
      const recentStart = this.timeStats.recentChapters[0].timestamp;
      const recentEnd =
        this.timeStats.recentChapters[this.timeStats.recentChapters.length - 1]
          .timestamp;
      const recentElapsed = recentEnd - recentStart;
      const recentCount = this.timeStats.recentChapters.length - 1;

      if (recentElapsed > 0) {
        currentSpeed = (recentCount / recentElapsed) * 3600000;
      }
    }

    return {
      current: currentSpeed,
      average: averageSpeed,
    };
  }

  private calculateETA(): {
    etaTime: string;
    etaFormatted: string;
    remainingMs: number;
  } {
    if (this.timeStats.totalScraped === 0) {
      return { etaTime: "N/A", etaFormatted: "N/A", remainingMs: 0 };
    }

    const now = Date.now();
    const elapsed = now - this.timeStats.startTime;
    const avgTimePerChapter = elapsed / this.timeStats.totalScraped;
    const remainingChapters =
      this.timeStats.totalChapters - this.timeStats.totalScraped;
    const remainingMs = remainingChapters * avgTimePerChapter;

    const finishTime = new Date(now + remainingMs);

    return {
      etaTime: finishTime.toLocaleString("vi-VN"),
      etaFormatted: this.formatTime(remainingMs),
      remainingMs: remainingMs,
    };
  }

  private formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    } else {
      return `${minutes}m ${seconds}s`;
    }
  }

  private displayLiveProgress(): void {
    if (this.timeStats.totalScraped === 0) return;

    const now = Date.now();
    const elapsed = now - this.timeStats.startTime;
    const eta = this.calculateETA();
    const speed = this.calculateCurrentSpeed();

    console.log(`\n⚡ ============ ULTRA-SPEED PROGRESS ============`);
    console.log(
      `📊 Đã cào: ${this.timeStats.totalScraped}/${
        this.timeStats.totalChapters
      } (${(
        (this.timeStats.totalScraped / this.timeStats.totalChapters) *
        100
      ).toFixed(1)}%)`
    );
    console.log(`⏱️ Đã chạy: ${this.formatTime(elapsed)}`);
    console.log(`🎯 Còn lại: ${eta.etaFormatted} (${eta.etaTime})`);
    console.log(
      `🚀 Tốc độ: ${speed.current.toFixed(1)} ch/h (TB: ${speed.average.toFixed(
        1
      )})`
    );
    console.log(`💾 Buffer: ${this.batchWriteBuffer.length} chapters`);
    console.log(`===============================================\n`);
  }

  private displayFinalStats(): void {
    const now = Date.now();
    const totalTime = now - this.timeStats.startTime;
    const speed = this.calculateCurrentSpeed();

    console.log(`\n🏆 ========== ULTRA-SPEED FINAL STATS ==========`);
    console.log(`📚 Tổng số chương: ${this.timeStats.totalScraped}`);
    console.log(`⏰ Tổng thời gian: ${this.formatTime(totalTime)}`);
    console.log(`⚡ Tốc độ trung bình: ${speed.average.toFixed(1)} chương/giờ`);
    console.log(`🔥 Tốc độ cao nhất: ${speed.current.toFixed(1)} chương/giờ`);
    console.log(
      `📈 Thời gian/chương: ${(
        totalTime /
        this.timeStats.totalScraped /
        1000
      ).toFixed(1)}s`
    );
    console.log(`🏁 Hoàn thành lúc: ${new Date(now).toLocaleString("vi-VN")}`);
    console.log(
      `💯 Hiệu suất: ${(
        (this.timeStats.totalScraped / this.timeStats.totalChapters) *
        100
      ).toFixed(1)}%`
    );
    console.log(`===============================================\n`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getStoryIdFromUrl(url: string): string {
    try {
      const parts = url.split("/");
      const novelIndex = parts.indexOf("novel");
      if (novelIndex > -1 && parts.length > novelIndex + 1) {
        return parts[novelIndex + 1];
      }

      const urlObj = new URL(url);
      return (
        urlObj.pathname.split("/").filter(Boolean).pop() ||
        url.replace(/[^a-zA-Z0-9-_]/g, "_")
      );
    } catch (error) {
      return url.replace(/[^a-zA-Z0-9-_]/g, "_");
    }
  }

  async openLoginBrowser(): Promise<void> {
    console.log("🌐 Mở trình duyệt để đăng nhập...");
    const manualBrowser = await this.createOptimizedBrowser(false);
    const manualPage = await manualBrowser.newPage();

    await manualPage.goto("https://truyen25h.com/login", {
      waitUntil: "networkidle2",
    });

    console.log("✅ Trình duyệt đã mở. Đăng nhập và đóng khi xong.");
  }
}

export default new UltraFastScraper();
