import Scraper from "./scraper"; // Hoặc import Scraper from './index'; nếu bạn muốn thông qua file index

/**
 * Hàm này dùng để mở trình duyệt cho việc đăng nhập thủ công.
 */
async function runLoginProcess() {
  console.log("Đang chuẩn bị mở trình duyệt để đăng nhập...");
  try {
    // Gọi phương thức tĩnh openLoginBrowser từ lớp Scraper
    await Scraper.openLoginBrowser();
    console.log("Trình duyệt đã được mở. Vui lòng đăng nhập vào trang web, sau đó đóng trình duyệt này.");
    console.log("Sau khi đăng nhập thành công, bạn có thể chạy lại tiến trình cào dữ liệu chính.");
  } catch (error) {
    console.error("Có lỗi xảy ra khi mở trình duyệt đăng nhập:", error);
  }
}

// Chạy hàm xử lý đăng nhập
runLoginProcess();