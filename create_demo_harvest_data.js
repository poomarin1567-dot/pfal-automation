const { Pool } = require('pg');

const pool = new Pool({
  host: '192.168.20.50',
  port: 5432,
  user: 'postgres',
  password: '123456',
  database: 'pfal'
});

async function createDemoHarvestData() {
  try {
    console.log('🌱 สร้างข้อมูลปลอมสำหรับแสดงฟีเจอร์การแจ้งเตือนการเก็บเกี่ยว...');
    
    const demoPlans = [
      {
        plan_id: 'DEMO-001',
        vegetable_type: 'ผักกาดหอม',
        plant_date: '2025-01-15',
        harvest_date: '2025-02-15', // กำหนดเก็บ 15 ก.พ.
        actual_harvest_date: '2025-02-10', // เก็บจริง 10 ก.พ. (เร็วกว่า 5 วัน)
        plant_count: 120,
        status: 'completed',
        completed_at: '2025-02-10 14:30:00',
        harvest_notes: 'เก็บเกี่ยวเร็วกว่ากำหนดเนื่องจากผักโตเร็วกว่าคาด'
      },
      {
        plan_id: 'DEMO-002', 
        vegetable_type: 'มะเขือเทศเชอรี่',
        plant_date: '2025-01-10',
        harvest_date: '2025-02-20', // กำหนดเก็บ 20 ก.พ.
        actual_harvest_date: '2025-02-17', // เก็บจริง 17 ก.พ. (เร็วกว่า 3 วัน)
        plant_count: 80,
        status: 'completed',
        completed_at: '2025-02-17 09:15:00',
        harvest_notes: 'ผลไม้สุกเร็วกว่าปกติ ต้องเก็บก่อนกำหนด'
      },
      {
        plan_id: 'DEMO-003',
        vegetable_type: 'แครอท',
        plant_date: '2025-01-05',
        harvest_date: '2025-02-25', // กำหนดเก็บ 25 ก.พ.
        actual_harvest_date: '2025-02-18', // เก็บจริง 18 ก.พ. (เร็วกว่า 7 วัน) 
        plant_count: 200,
        status: 'completed',
        completed_at: '2025-02-18 16:45:00',
        harvest_notes: 'แครอทโตเต็มขนาดแล้ว เก็บก่อนเพื่อไม่ให้แกปาก'
      },
      {
        plan_id: 'DEMO-004',
        vegetable_type: 'ผักบุ้งจีน',
        plant_date: '2025-01-20',
        harvest_date: '2025-02-10', // กำหนดเก็บ 10 ก.พ.
        actual_harvest_date: '2025-02-08', // เก็บจริง 8 ก.พ. (เร็วกว่า 2 วัน)
        plant_count: 150,
        status: 'completed', 
        completed_at: '2025-02-08 11:20:00',
        harvest_notes: 'ใบอ่อนสวยงาม เก็บเพื่อคุณภาพ'
      },
      {
        plan_id: 'DEMO-005',
        vegetable_type: 'เคล',
        plant_date: '2025-01-12',
        harvest_date: '2025-02-12', // กำหนดเก็บ 12 ก.พ.
        actual_harvest_date: '2025-02-12', // เก็บตรงเวลา (ไม่มีการแจ้งเตือน)
        plant_count: 90,
        status: 'completed',
        completed_at: '2025-02-12 13:00:00',
        harvest_notes: 'เก็บเกี่ยวตามกำหนดเวลาพอดี'
      }
    ];

    console.log('\n📝 เพิ่มข้อมูลปลอม...');
    
    for (const plan of demoPlans) {
      const result = await pool.query(`
        INSERT INTO planting_plans (
          plan_id, vegetable_type, plant_date, harvest_date, actual_harvest_date,
          plant_count, status, completed_at, harvest_notes, 
          created_at, updated_at, created_by, completed_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id, plan_id, vegetable_type
      `, [
        plan.plan_id, 
        plan.vegetable_type, 
        plan.plant_date, 
        plan.harvest_date,
        plan.actual_harvest_date,
        plan.plant_count, 
        plan.status, 
        plan.completed_at,
        plan.harvest_notes,
        new Date(), 
        new Date(),
        'demo_user',
        'demo_harvester'
      ]);

      const planData = result.rows[0];
      
      // คำนวณการเก็บเกี่ยวก่อนกำหนด
      if (plan.actual_harvest_date !== plan.harvest_date) {
        const actualDate = new Date(plan.actual_harvest_date);
        const plannedDate = new Date(plan.harvest_date);
        const daysEarly = Math.ceil((plannedDate - actualDate) / (1000 * 60 * 60 * 24));
        
        if (daysEarly > 0) {
          console.log(`✅ เพิ่ม: ${planData.vegetable_type} (เก็บก่อนกำหนด ${daysEarly} วัน)`);
        } else {
          console.log(`✅ เพิ่ม: ${planData.vegetable_type} (เก็บตามกำหนด)`);
        }
      } else {
        console.log(`✅ เพิ่ม: ${planData.vegetable_type} (เก็บตามกำหนด)`);
      }
    }

    // ตรวจสอบผลลัพธ์
    console.log('\n📊 ตรวจสอบข้อมูลที่สร้าง...');
    const checkResult = await pool.query(`
      SELECT 
        plan_id, vegetable_type, 
        harvest_date, actual_harvest_date,
        CASE 
          WHEN actual_harvest_date < harvest_date 
          THEN harvest_date - actual_harvest_date 
          ELSE 0 
        END as days_early,
        harvest_notes
      FROM planting_plans 
      WHERE plan_id LIKE 'DEMO-%'
      ORDER BY plan_id
    `);

    console.log('\n📋 ข้อมูลปลอมที่สร้าง:');
    checkResult.rows.forEach(row => {
      const earlyText = row.days_early > 0 ? `⚠️ เร็วกว่า ${row.days_early} วัน` : '✅ ตรงเวลา';
      console.log(`- ${row.plan_id}: ${row.vegetable_type} ${earlyText}`);
      console.log(`  กำหนด: ${row.harvest_date.toISOString().split('T')[0]} | จริง: ${row.actual_harvest_date.toISOString().split('T')[0]}`);
    });

    console.log('\n🎉 สร้างข้อมูลปลอมเรียบร้อย! ตอนนี้สามารถไปดูในหน้าประวัติได้แล้ว');
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await pool.end();
  }
}

createDemoHarvestData();