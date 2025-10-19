# 💠 NFT Market — Stellar Soroban DApp

**NFT Market** là một ứng dụng phi tập trung (DApp) được xây dựng trên **Stellar Soroban**, cho phép người dùng **tạo (mint)**, **xem**, **chuyển**, và **mua bán NFT pixel-art** trực tiếp trên blockchain.

---

## 🚀 Giới thiệu

Dự án minh họa cách kết hợp giữa:
- **Smart Contract Soroban (Rust)** – xử lý logic token, NFT và marketplace.  
- **Frontend React + Vite** – giao diện người dùng hiện đại, trực quan.  
- **Ví Freighter** – kết nối và ký giao dịch an toàn, không qua trung gian.

---

## 🧩 Chức năng chính

| Chức năng | Mô tả |
|------------|--------|
| 🖼️ **Mint NFT** | Tạo NFT 9×9 pixel từ chuỗi hoặc lưới màu. |
| 🔍 **Xem NFT** | Hiển thị NFT từ blockchain trên canvas. |
| 🔄 **Chuyển NFT** | Gửi NFT cho ví khác (địa chỉ G...). |
| 💱 **Marketplace** | Đăng bán, mua, hoặc hủy NFT trên chuỗi. |
| 🎨 **Palette** | Sử dụng bảng màu DB32 32-bit, có thể tải lại từ contract. |
| 💰 **Token Layer** | Quản lý token cơ bản (name, symbol, decimals, balance). |

---

## ⚙️ Kiến trúc hệ thống

User → Freighter Wallet → React DApp → Soroban RPC → Smart Contract → Stellar Blockchain


- **Frontend:** React + TypeScript + Vite  
- **Wallet:** Freighter (Stellar official extension)  
- **Blockchain:** Stellar Soroban (testnet hoặc futurenet)  
- **Smart Contract:** Viết bằng Rust, triển khai qua CLI Soroban

---

## 🧱 Cấu trúc dự án


---

## 🪙 Các hợp đồng Soroban

| Contract | Mục đích | Hàm chính |
|-----------|-----------|-----------|
| **Token Contract** | Token fungible (balance, transfer) | `transfer`, `balance_of`, `total_supply` |
| **NFT Contract** | Quản lý NFT pixel-art | `mint`, `read_value`, `transfer`, `read_ids_of` |
| **Market Contract** | Marketplace on-chain | `list`, `cancel`, `buy`, `get` |

---

## ⚡ Cài đặt & chạy thử

### 1️⃣ Clone dự án
```bash
git clone https://github.com/trinhieu/NFT_Market.git
cd NFT_Market
### thực hiện các bước trong command file kết hợp tài liệu của stellar 
