# 📖 Watchdog Monitor Simulator (Kiwi 1P5)

Chào mừng bạn đến với tài liệu hướng dẫn sử dụng Watchdog Monitor Simulator. Đây là ứng dụng Dashboard mô phỏng hoàn chỉnh nguyên lý hoạt động của khối RTL Watchdog Supervisor (dựa trên IC TPS3431) dành cho board FPGA Gowin GW1N-UV1P5 (Kiwi 1P5).

## 🌟 1. Giới thiệu tổng quan

Ứng dụng này cung cấp một môi trường mô phỏng trực quan (Software-in-the-Loop) giúp kiểm chứng logic của máy trạng thái (FSM) và giao thức UART trước khi đưa xuống phần cứng FPGA thực tế.

**Các tính năng cốt lõi:**
- **Hardware Mockup:** Mô phỏng chính xác logic phần cứng Active-Low của các nút bấm và LED trên board Kiwi 1P5.
- **FSM Engine:** Máy trạng thái thời gian thực với chu kỳ quét 20ms, mô phỏng các trạng thái `DISABLE` -> `ARMING` -> `MONITORING` -> `FAULT`.
- **Register Map:** Bảng thanh ghi động tự động cập nhật, hỗ trợ đọc/ghi thông số hệ thống.
- **UART Protocol Builder:** Công cụ tạo khung truyền (Frame) UART giả lập chuẩn công nghiệp có hỗ trợ tự động tính Checksum (XOR) và mô phỏng phản hồi (ACK/RESP).

---

## 🚀 2. Cài đặt và Khởi chạy

Vì ứng dụng được xây dựng bằng thư viện React (kèm TailwindCSS và Lucide Icons), bạn có thể chạy dự án thông qua Node.js:

```bash
# 1. Clone repository về máy
git clone https://github.com/hijoouzc/Watchdog_Simulator_for_Kiwi_1P5
cd watchdog-simulator

# 2. Cài đặt các gói phụ thuộc
npm install

# 3. Khởi chạy server phát triển
npm start
```

Trình duyệt sẽ tự động mở ứng dụng tại địa chỉ `http://localhost:3000`.

---

## 🖥️ 3. Hướng dẫn Giao diện (UI & Modules)

Giao diện được chia làm 4 module chính:

### 3.1. Hardware GPIO (Mô phỏng phần cứng)
- **S2 (EN):** Công tắc kích hoạt hệ thống. Mặc định ở mức Disable (0). Khi gạt sang Enable (1), hệ thống bắt đầu đếm `arm_delay`.
- **S1 (WDI):** Nút giả lập sự kiện Watchdog Kick. Nhấn nút này tạo ra một cạnh xuống (Falling Edge) để báo cho hệ thống biết vi điều khiển vẫn đang sống.
- **LED D4 (ENOUT):** Bật sáng (Xanh) khi hệ thống đã vượt qua `arm_delay` và sẵn sàng giám sát.
- **LED D3 (WDO):** LED cảnh báo lỗi (Active-Low). Sáng (Đỏ) khi xảy ra sự kiện Timeout.

### 3.2. FSM Real-time Engine
Thanh Progress Bar sẽ trượt để thể hiện thời gian thực (ms) của bộ đếm. Màu sắc thay đổi theo trạng thái:
- ⬛ **Xám (DISABLE):** Hệ thống đang tắt.
- 🟨 **Vàng (ARMING):** Hệ thống đang đếm `arm_delay`. Các tín hiệu kick (S1) lúc này bị bỏ qua.
- 🟦 **Xanh dương (MONITORING):** Hệ thống đang giám sát. Đếm lùi `tWD`.
- 🟥 **Đỏ (FAULT):** Báo lỗi timeout, đếm thời gian giữ lỗi `tRST`.

### 3.3. Register Map (Bản đồ thanh ghi)
Cho phép quan sát trạng thái của hệ thống thông qua các địa chỉ vùng nhớ:
- `0x00` **(CTRL):** Cấu hình nguồn kích, ép clear lỗi...
- `0x04` **(tWD_ms):** Thời gian timeout (Mặc định: 1600ms).
- `0x08` **(tRST_ms):** Thời gian giữ cờ lỗi (Mặc định: 200ms).
- `0x0C` **(arm_delay_us):** Thời gian an toàn sau khi Enable.
- `0x10` **(STATUS):** Thanh ghi Read-Only báo cáo trạng thái FSM (cập nhật liên tục).

### 3.4. UART 9600 8N1 Builder
Công cụ giúp bạn tương tác với phần cứng ảo thông qua các lệnh UART. Định dạng Frame:
`[0x55] [CMD] [ADDR] [LEN] [DATA...] [CHK]`

- **CMD 0x01 (WRITE):** Dùng để đổi thông số `tWD`, `tRST`,...
- **CMD 0x02 (READ):** Đọc giá trị thanh ghi.
- **CMD 0x03 (KICK):** Thực hiện Kick bằng Software (UART).
- **CMD 0x04 (STATUS):** Truy vấn nhanh thanh ghi `STATUS`.

---

## 🎯 4. Các Kịch bản Thử nghiệm (Test Cases)

Để hiểu rõ nguyên lý, hãy thực hiện các bước sau trên Dashboard:

**Kịch bản 1: Hoạt động bình thường (Normal Kick)**
1. Bật công tắc S2 (EN).
2. Quan sát FSM chuyển sang ARMING (màu vàng).
3. Đợi hết thời gian Arming, FSM sang MONITORING (màu xanh dương) và LED D4 (ENOUT) bật sáng.
4. Chờ thanh thời gian gần chạm mốc 1600ms, ấn nút S1 (WDI).
*Kết quả:* Thanh thời gian reset về 0, FSM thông báo nhận được sườn xuống (Falling).

**Kịch bản 2: Báo lỗi Timeout & Phục hồi**
1. Đang ở trạng thái MONITORING, không ấn bất kỳ nút nào.
2. Chờ thanh thời gian đếm vượt qua `tWD` (1600ms).
*Kết quả:* FSM chuyển sang FAULT (Đỏ). Đèn LED D3 (WDO) chớp báo lỗi (0).
*Hệ thống sẽ giữ lỗi trong thời gian `tRST` (200ms) sau đó tự động nhả WDO và quay lại trạng thái MONITORING.*

**Kịch bản 3: Thay đổi tham số qua UART (Runtime Config)**
1. Ở ô UART Builder, chọn CMD: `0x01` (WRITE).
2. Chọn ADDR: `0x04` (tWD).
3. Nhập DATA: `500` và ấn Send Frame.
*Kết quả:* FSM Engine lập tức tăng tốc vì ngưỡng timeout nay chỉ còn 500ms thay vì 1600ms. Xem log Console để đối chiếu chuỗi Hex được sinh ra.

**Kịch bản 4: Xoá lỗi khẩn cấp (CLR_FAULT)**
1. Cố tình để hệ thống rơi vào trạng thái lỗi (FAULT).
2. Lập tức ấn nút tắt **CLR_FAULT** ở góc phải (Nút này sẽ tự động gửi lệnh Write giá trị `4` vào thanh ghi CTRL `0x00` - tương ứng set bit 2).
*Kết quả:* Đèn báo lỗi D3 bị tắt ngay lập tức, FSM quay trở lại MONITORING dù chưa hết thời gian `tRST`.

---
> 💡 *Tài liệu được biên soạn dựa trên đặc tả của dự án Vòng 1 RTL Cuộc thi FPGA Mở Rộng 2026. Nếu có bất kỳ thắc mắc nào về luồng hoạt động, hãy tham chiếu log trên terminal giả lập.*# 📖 Kiwi 1P5 Watchdog Monitor Simulator
