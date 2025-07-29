-- ✅ สร้างตารางสำหรับระบบแผนการปลูกและใบงาน
-- รันคำสั่งนี้ใน PostgreSQL เพื่อสร้างตารางที่จำเป็น

-- ลบตารางเก่าหากมี (ระวัง: จะลบข้อมูลทั้งหมด)
DROP TABLE IF EXISTS work_order_tasks CASCADE;
DROP TABLE IF EXISTS work_orders CASCADE;
DROP TABLE IF EXISTS planting_plans CASCADE;

-- ✅ ตาราง planting_plans - เก็บข้อมูลแผนการปลูกจากภายนอก
CREATE TABLE planting_plans (
    id SERIAL PRIMARY KEY,
    external_plan_id VARCHAR(50),
    vegetable_name VARCHAR(100) NOT NULL,
    level INTEGER NOT NULL,
    planting_date DATE NOT NULL,
    harvest_date DATE NOT NULL,
    plant_count INTEGER NOT NULL,
    variety VARCHAR(100),
    batch_number VARCHAR(50),
    source_system VARCHAR(100),
    received_at TIMESTAMP DEFAULT NOW(),
    status VARCHAR(20) DEFAULT 'received',
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ✅ ตาราง work_orders - ใบงานที่สร้างจากแผนการปลูก
CREATE TABLE work_orders (
    id SERIAL PRIMARY KEY,
    planting_plan_id INTEGER REFERENCES planting_plans(id),
    work_order_number VARCHAR(50) UNIQUE,
    task_type VARCHAR(50) NOT NULL,  -- 'planting', 'harvest', 'maintenance'
    vegetable_name VARCHAR(100) NOT NULL,
    level INTEGER NOT NULL,
    target_date DATE NOT NULL,
    plant_count INTEGER NOT NULL,
    assigned_to VARCHAR(100),
    priority VARCHAR(20) DEFAULT 'normal',  -- 'low', 'normal', 'high', 'urgent'
    status VARCHAR(20) DEFAULT 'pending',   -- 'pending', 'in_progress', 'completed', 'cancelled'
    progress INTEGER DEFAULT 0,             -- 0-100%
    actual_count INTEGER,
    completed_at TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ✅ ตาราง work_order_tasks - รายละเอียดงานย่อย
CREATE TABLE work_order_tasks (
    id SERIAL PRIMARY KEY,
    work_order_id INTEGER REFERENCES work_orders(id),
    task_name VARCHAR(100) NOT NULL,
    description TEXT,
    sequence_order INTEGER,
    estimated_duration INTEGER,  -- นาที
    actual_duration INTEGER,     -- นาที
    status VARCHAR(20) DEFAULT 'pending',
    assigned_to VARCHAR(100),
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ✅ สร้าง Index เพื่อเพิ่มประสิทธิภาพ
CREATE INDEX idx_planting_plans_status ON planting_plans(status);
CREATE INDEX idx_planting_plans_level ON planting_plans(level);
CREATE INDEX idx_planting_plans_dates ON planting_plans(planting_date, harvest_date);

CREATE INDEX idx_work_orders_status ON work_orders(status);
CREATE INDEX idx_work_orders_task_type ON work_orders(task_type);
CREATE INDEX idx_work_orders_level ON work_orders(level);
CREATE INDEX idx_work_orders_target_date ON work_orders(target_date);

CREATE INDEX idx_work_order_tasks_status ON work_order_tasks(status);
CREATE INDEX idx_work_order_tasks_work_order_id ON work_order_tasks(work_order_id);

-- ✅ เพิ่มข้อมูลตัวอย่างสำหรับทดสอบ
INSERT INTO planting_plans (
    external_plan_id, vegetable_name, level, planting_date, harvest_date, 
    plant_count, variety, batch_number, source_system, status
) VALUES 
('EXT001', 'ผักกาดหอม', 1, '2024-01-15', '2024-02-15', 100, 'Butterhead', 'B001', 'External Planning System', 'received'),
('EXT002', 'คะน้า', 2, '2024-01-16', '2024-02-20', 80, 'Thai Kale', 'B002', 'External Planning System', 'received'),
('EXT003', 'ผักกาดขาว', 3, '2024-01-17', '2024-02-18', 120, 'Napa Cabbage', 'B003', 'External Planning System', 'received');

-- ✅ สร้างใบงานตัวอย่าง
INSERT INTO work_orders (
    planting_plan_id, work_order_number, task_type, vegetable_name, 
    level, target_date, plant_count, priority, status
) VALUES 
(1, 'WO-1737267600000-1-PLANT', 'planting', 'ผักกาดหอม', 1, '2024-01-15', 100, 'high', 'pending'),
(1, 'WO-1737267600000-1-HARVEST', 'harvest', 'ผักกาดหอม', 1, '2024-02-15', 100, 'normal', 'pending'),
(2, 'WO-1737267600000-2-PLANT', 'planting', 'คะน้า', 2, '2024-01-16', 80, 'high', 'pending'),
(2, 'WO-1737267600000-2-HARVEST', 'harvest', 'คะน้า', 2, '2024-02-20', 80, 'normal', 'pending');

-- ✅ แสดงข้อมูลที่สร้างเสร็จแล้ว
SELECT 'Tables created successfully!' as message;
SELECT 'Planting Plans Count: ' || COUNT(*) as count FROM planting_plans;
SELECT 'Work Orders Count: ' || COUNT(*) as count FROM work_orders;