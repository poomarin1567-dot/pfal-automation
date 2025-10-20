# AGROTECH WMS - Smart Farm Management System

> ระบบจัดการฟาร์มอัจฉริยะแบบครบวงจร (Warehouse Management System + ERP) สำหรับฟาร์มแนวตั้ง (Vertical Farm / Plant Factory with Artificial Lighting)

![Version](https://img.shields.io/badge/version-4.5.0-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

---

## ภาพหน้าจอระบบ

### Dashboard หลัก
https://github.com/poomarin1567-dot/pfal-automation?tab=readme-ov-file

### ระบบจัดการแผนการปลูก
![Planting Plan](https://via.placeholder.com/800x400/52b788/ffffff?text=Planting+Plan+Management)

### ระบบควบคุมน้ำอัตโนมัติ
![Water Control](https://via.placeholder.com/800x400/74c69d/ffffff?text=Smart+Water+Control)

---

## ฟีเจอร์หลัก

### ระบบจัดการหลัก
- **Dashboard** - แสดงสถานะและข้อมูลแบบ Real-time
- **Work Order System** - จัดการใบงานอัตโนมัติ (Sow, Transplant, Harvest)
- **Planting Plan Management** - วางแผนการปลูกและติดตามความคืบหน้า
- **Inventory Management** - จัดการถาดปลูกและสินค้าคงคลัง
- **Reports & Analytics** - รายงานสถิติและวิเคราะห์ข้อมูล

### ระบบควบคุมอัตโนมัติ
- **Smart Water Control** - ควบคุมระบบน้ำอัตโนมัติผ่าน MQTT/Modbus
- **Light Control** - ควบคุมแสงอัตโนมัติตามตารางเวลา
- **Environmental Monitoring** - ตรวจสอบอุณหภูมิ ความชื้น คุณภาพอากาศ
- **Schedule Automation** - ตั้งเวลาทำงานอัตโนมัติ

### ระบบผู้ใช้
- **Authentication** - ระบบ Login/Logout ที่ปลอดภัย
- **User Management** - จัดการผู้ใช้งาน 2 ระดับ (Admin, Operator)
- **Real-time Updates** - อัพเดทข้อมูลแบบ Real-time ด้วย WebSocket

---

## เทคโนโลยีที่ใช้

### Frontend
- **HTML5/CSS3** - โครงสร้างและการออกแบบ
- **Tailwind CSS** - Styling framework
- **JavaScript (Vanilla)** - Logic และ Interactivity
- **Chart.js** - สำหรับกราฟและสถิติ
- **MQTT.js** - การสื่อสารแบบ Real-time
- **WebSocket** - Push notifications

### Backend
- **Node.js** - Runtime environment
- **Express.js** - Web framework
- **PostgreSQL** - ฐานข้อมูล
- **MQTT** - IoT communication protocol
- **JWT** - Authentication
- **bcrypt** - Password encryption

### IoT & Automation
- **MQTT Broker** - Message broker สำหรับ IoT
- **Modbus TCP/IP** - Protocol สำหรับควบคุม PLC

---

## การติดตั้ง

### ความต้องการของระบบ
- Node.js >= 14.0.0
- PostgreSQL >= 12.0
- MQTT Broker (Mosquitto หรือ HiveMQ)

### ขั้นตอนการติดตั้ง

1. **Clone repository**
```bash
git clone https://github.com/poomarin1567-dot/pfal-automation.git
cd pfal-automation
```

2. **ติดตั้ง dependencies**
```bash
npm install
```

3. **ตั้งค่าฐานข้อมูล**
```bash
# สร้างฐานข้อมูล PostgreSQL
createdb pfal

# Import database schema (ถ้ามี)
psql -U postgres -d pfal -f database_schema.sql
```

4. **ตั้งค่า environment variables**
```bash
# สร้างไฟล์ .env
cp .env.example .env

# แก้ไขค่าใน .env
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=yourpassword
DB_DATABASE=pfal

MQTT_HOST=your-mqtt-broker.com
MQTT_USERNAME=username
MQTT_PASSWORD=password
```

5. **รันโปรเจค**
```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

6. **เปิดเว็บเบราว์เซอร์**
```
http://localhost:3000
```

---

## การเข้าสู่ระบบ

### บัญชี Demo
- **Username**: `admin`
- **Password**: `1234`

---

## โครงสร้างโปรเจค

```
pfal-automation/
├── index.html              # หน้าหลัก (Login)
├── index.js                # Backend server
├── db.js                   # Database connection
├── package.json            # Dependencies
├── .env                    # Environment variables (ไม่ควร commit)
├── .gitignore              # Git ignore rules
├── README.md               # Documentation
└── node_modules/           # Dependencies (auto-generated)
```

---

## Security Features

- Password hashing ด้วย bcrypt
- JWT token authentication
- Session management
- SQL injection prevention
- XSS protection
- CORS configuration

---

## การ Deploy

### แนะนำ Platform (ฟรี)

**Frontend**
- Vercel
- Netlify
- GitHub Pages

**Backend**
- Render.com
- Railway.app
- Heroku

**Database**
- Supabase (PostgreSQL)
- ElephantSQL
- Neon.tech

---

## การใช้งาน

### 1. Dashboard
- ดูภาพรวมของฟาร์ม
- ติดตามสถานะ Real-time
- ดูการแจ้งเตือน

### 2. Planting Plan
- สร้างแผนการปลูกใหม่
- กำหนดพันธุ์พืช จำนวน และช่วงเวลา
- ติดตามความคืบหน้าการปลูก

### 3. Work Orders
- ดูรายการงานทั้งหมด
- จัดการสถานะงาน (Pending, In Progress, Completed)
- พิมพ์ใบงาน

### 4. Water Control
- ควบคุมระบบน้ำแบบ Manual/Auto
- ตั้งเวลาการรดน้ำ
- ดูประวัติการรดน้ำ

### 5. Light Control
- ควบคุมไฟแบบ Manual/Auto
- ตั้งเวลาเปิด-ปิดไฟ
- ปรับความเข้มแสง

---

## การพัฒนา

### Roadmap
- [ ] Mobile Application (React Native)
- [ ] Advanced Analytics & AI
- [ ] Multi-farm Support
- [ ] Automated Reporting
- [ ] API Documentation

### Contributing
Pull requests are welcome! สำหรับการเปลี่ยนแปลงขนาดใหญ่ กรุณาเปิด issue เพื่อหารือก่อน

---

## License

MIT License - ดูรายละเอียดใน [LICENSE](LICENSE)

---

## ผู้พัฒนา

พัฒนาโดย **Poomarin**
- GitHub: [@poomarin1567-dot](https://github.com/poomarin1567-dot)

---

## ขอบคุณ

ขอบคุณ Open Source Libraries และเครื่องมือทั้งหมดที่ใช้ในโปรเจคนี้

---

**ถ้าชอบโปรเจคนี้ กรุณากด Star ให้ด้วยนะครับ!**
