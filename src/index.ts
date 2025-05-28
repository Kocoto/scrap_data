// src/index.ts
import Scraper from "./scraper";
import * as readline from "readline";

// Hàm tiện ích để hỏi người dùng và trả về một Promise
function askQuestion(query: string, rl: readline.Interface): Promise<string> {
  return new Promise((resolve) => rl.question(query, (ans) => resolve(ans)));
}

// Hàm chính để cào truyện
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("Chào mừng bạn đến với chương trình cào truyện!");
    const storyBaseUrl = await askQuestion(
      "Vui lòng nhập URL gốc của truyện (ví dụ: https://truyen25h.com/novel/thap-nhat-chung-yen-dich): ",
      rl
    );

    if (!storyBaseUrl) {
      console.log("URL truyện không được để trống. Đang thoát...");
      rl.close();
      return;
    }

    const numInstancesStr = await askQuestion(
      "Bạn muốn chạy bao nhiêu browser instances? (mặc định: 3): ",
      rl
    );
    const numPagesPerInstanceStr = await askQuestion(
      "Mỗi instance có bao nhiêu pages? (mặc định: 5): ",
      rl
    );
    const totalChaptersStr = await askQuestion(
      "Truyện có tổng cộng bao nhiêu chương? (bỏ trống nếu không biết, sẽ dùng giá trị mặc định hoặc cố gắng tìm): ",
      rl
    );

    const numInstances = parseInt(numInstancesStr) || 3; // Giá trị mặc định nếu input không hợp lệ
    const numPagesPerInstance = parseInt(numPagesPerInstanceStr) || 5; // Giá trị mặc định
    const totalChapters = totalChaptersStr
      ? parseInt(totalChaptersStr)
      : undefined;

    console.log(`\nCấu hình chạy:`);
    console.log(`- URL truyện: ${storyBaseUrl}`);
    console.log(`- Số browser instances: ${numInstances}`);
    console.log(`- Số pages mỗi instance: ${numPagesPerInstance}`);
    if (totalChapters) {
      console.log(`- Tổng số chương: ${totalChapters}`);
    } else {
      console.log(
        `- Tổng số chương: Sẽ cố gắng cào tối đa hoặc theo cấu hình mặc định.`
      );
    }
    console.log("\nBắt đầu quá trình cào dữ liệu...\n");

    // Truyền các giá trị này vào Scraper
    // Giả sử Scraper là một instance, nếu nó là static class thì cần điều chỉnh cách gọi
    // Hiện tại Scraper được export default new UltraFastScraper(); nên nó là một instance.
    await Scraper.scrapeStory(
      storyBaseUrl,
      numInstances,
      numPagesPerInstance,
      totalChapters
    );
  } catch (error) {
    console.error("Đã xảy ra lỗi trong quá trình chính:", error);
  } finally {
    rl.close();
  }
}

// Chạy hàm chính
main();

// Export Scraper để người dùng có thể gọi Scraper.openLoginBrowser() thủ công nếu cần
export default Scraper;
