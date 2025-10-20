const { Pool } = require('pg');

const pool = new Pool({
  host: '192.168.20.50',
  port: 5432,
  user: 'postgres',
  password: '123456',
  database: 'pfal',
  max: 2,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 5000,
});

async function createTrayInventoryData() {
  const client = await pool.connect();
  
  try {
    console.log('🌱 สร้างข้อมูลทดสอบ tray_inventory...');

    // ล้างข้อมูลเก่า
    await client.query('DELETE FROM tray_inventory');
    console.log('✅ ล้างข้อมูลเก่า tray_inventory');

    // ดึง planting plans ที่มีอยู่
    const plantingPlans = await client.query(`
      SELECT id, plan_id, vegetable_type, plant_count, plant_date
      FROM planting_plans 
      ORDER BY id
    `);

    console.log(`📋 พบ planting plans: ${plantingPlans.rows.length} รายการ`);

    // สร้างข้อมูล tray_inventory สำหรับแต่ละ planting plan
    for (const plan of plantingPlans.rows) {
      const traysNeeded = Math.ceil(plan.plant_count / 50); // สมมติ 1 tray ได้ 50 ต้น
      
      console.log(`📦 สร้าง ${traysNeeded} ถาดสำหรับ ${plan.plan_id} (${plan.vegetable_type})`);
      
      for (let i = 1; i <= traysNeeded; i++) {
        const trayId = `${plan.plan_id}-T${i.toString().padStart(2, '0')}`;
        const plantsInThisTray = Math.min(50, plan.plant_count - ((i - 1) * 50));
        
        // สร้างตำแหน่งสุ่ม (station 1-3, floor 1-5, slot 1-20)
        const station = Math.floor(Math.random() * 3) + 1;
        const floor = Math.floor(Math.random() * 5) + 1;
        const slot = Math.floor(Math.random() * 20) + 1;
        
        await client.query(`
          INSERT INTO tray_inventory (
            tray_id, veg_type, floor, slot, plant_quantity,
            seeding_date, status, station_id, planting_plan_id,
            username, notes
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          trayId,
          plan.vegetable_type,
          floor,
          slot,
          plantsInThisTray,
          plan.plant_date,
          'on_shelf', // สถานะเริ่มต้น
          station,
          plan.id,
          'system',
          `ถาดทดสอบสำหรับ ${plan.vegetable_type} จำนวน ${plantsInThisTray} ต้น`
        ]);
      }
    }

    // สร้างข้อมูลเพิ่มเติมสำหรับการทดสอบสถานะต่างๆ
    const additionalTrays = [
      {
        tray_id: 'EMPTY-001',
        veg_type: null,
        status: 'empty',
        plant_quantity: 0,
        notes: 'ถาดว่างพร้อมใช้งาน'
      },
      {
        tray_id: 'GROWING-001',
        veg_type: 'ผักกาดขาว',
        status: 'growing',
        plant_quantity: 45,
        seeding_date: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), // 15 วันที่แล้ว
        notes: 'ผักกำลังเจริญเติบโต'
      },
      {
        tray_id: 'READY-001',
        veg_type: 'ผักบุ้งจีน',
        status: 'ready_harvest',
        plant_quantity: 40,
        seeding_date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 วันที่แล้ว
        notes: 'พร้อมเก็บเกี่ยว'
      }
    ];

    for (const tray of additionalTrays) {
      const station = Math.floor(Math.random() * 3) + 1;
      const floor = Math.floor(Math.random() * 5) + 1;
      const slot = Math.floor(Math.random() * 20) + 1;
      
      await client.query(`
        INSERT INTO tray_inventory (
          tray_id, veg_type, floor, slot, plant_quantity,
          seeding_date, status, station_id, username, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        tray.tray_id,
        tray.veg_type,
        floor,
        slot,
        tray.plant_quantity,
        tray.seeding_date || null,
        tray.status,
        station,
        'system',
        tray.notes
      ]);
    }

    // แสดงสรุปข้อมูล
    const totalCount = await client.query('SELECT COUNT(*) as count FROM tray_inventory');
    console.log(`\n📊 สร้าง tray_inventory ทั้งหมด: ${totalCount.rows[0].count} รายการ`);

    // แสดงสถิติตามสถานะ
    const statusStats = await client.query(`
      SELECT 
        status,
        COUNT(*) as count,
        SUM(plant_quantity) as total_plants
      FROM tray_inventory 
      GROUP BY status
      ORDER BY count DESC
    `);

    console.log('\n=== สถิติตามสถานะ ===');
    statusStats.rows.forEach(stat => {
      console.log(`${stat.status}: ${stat.count} ถาด, ${stat.total_plants} ต้น`);
    });

    // แสดงตัวอย่างข้อมูล
    const sampleData = await client.query(`
      SELECT 
        ti.tray_id, ti.veg_type, ti.status, ti.plant_quantity,
        ti.station_id, ti.floor, ti.slot,
        pp.plan_id
      FROM tray_inventory ti
      LEFT JOIN planting_plans pp ON ti.planting_plan_id = pp.id
      ORDER BY ti.tray_id
      LIMIT 10
    `);

    console.log('\n=== ตัวอย่างข้อมูล tray_inventory ===');
    sampleData.rows.forEach(tray => {
      const location = `S${tray.station_id}F${tray.floor}S${tray.slot}`;
      const planInfo = tray.plan_id ? ` (Plan: ${tray.plan_id})` : '';
      console.log(`${tray.tray_id}: ${tray.veg_type || 'Empty'} - ${tray.status} - ${tray.plant_quantity} ต้น @ ${location}${planInfo}`);
    });

    console.log('\n🎉 สร้างข้อมูล tray_inventory เรียบร้อยแล้ว!');

  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาด:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

createTrayInventoryData();