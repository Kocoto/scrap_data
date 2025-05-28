// src/index.ts
import Scraper from "./scraper";

// Hàm chính để cào truyện
async function main() {
  const storyBaseUrl = "https://truyen25h.com/novel/thap-nhat-chung-yen-dich"; // URL gốc của truyện
  await Scraper.scrapeStory(storyBaseUrl);
}

// Chạy hàm chính
main();

// Export Scraper để người dùng có thể gọi Scraper.openLoginBrowser() thủ công
export default Scraper;
