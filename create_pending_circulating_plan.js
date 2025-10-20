const pool = require('./db');

async function createPendingPlans() {
  try {
    console.log('=== สร้างแผนการปลูกทดสอบระบบน้ำเวียน ===\n');

    // วันที่สำหรับทดสอบ
    const today = new Date();
    const plantDate = new Date(today);
    plantDate.setDate(plantDate.getDate() + 3); // ปลูกในอีก 3 วัน

    const harvestDate = new Date(plantDate);
    harvestDate.setDate(harvestDate.getDate() + 28); // เก็บเกี่ยวหลังจากปลูก 28 วัน

    const waterCloseDate = new Date(harvestDate);
    waterCloseDate.setDate(waterCloseDate.getDate() - 2); // ปิดน้ำ 2 วันก่อนเก็บเกี่ยว

    console.log(`📅 วันปลูก: ${plantDate.toISOString().split('T')[0]}`);
    console.log(`🌾 วันเก็บเกี่ยว: ${harvestDate.toISOString().split('T')[0]}`);
    console.log(`💧 วันปิดน้ำ: ${waterCloseDate.toISOString().split('T')[0]}\n`);

    // สร้างแผนการปลูก 3 แผน
    const vegetables = [
      { name: 'ผักกาดหอม', count: 50, ec: 1.5, ph: 6.0 },
      { name: 'คอสเลตุ๊ก', count: 40, ec: 1.8, ph: 5.8 },
      { name: 'ผักสลัด', count: 60, ec: 1.6, ph: 6.2 }
    ];

    let createdCount = 0;
    for (const veg of vegetables) {
      const planId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const result = await pool.query(`
        INSERT INTO planting_plans (
          plan_id, vegetable_type, plant_date, harvest_date,
          plant_count, status, water_system, water_close_date,
          ec_value, ph_value, station_id,
          created_by, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        RETURNING id, plan_id, vegetable_type
      `, [
        planId,
        veg.name,
        plantDate,
        harvestDate,
        veg.count,
        'pending',
        'circulating',
        waterCloseDate,
        veg.ec,
        veg.ph,
        1,
        'Admin'
      ]);

      createdCount++;
      const created = result.rows[0];
      console.log(`✅ ${createdCount}. สร้างแผนการปลูก: ${created.vegetable_type}`);
      console.log(`   Plan ID: ${created.plan_id}`);
      console.log(`   จำนวน: ${veg.count} ต้น`);
      console.log(`   EC: ${veg.ec} | pH: ${veg.ph}`);
      console.log(`   ระบบน้ำ: น้ำเวียน (circulating)`);
      console.log(`   สถานะ: pending\n`);
    }

    console.log(`\n✅ สร้างแผนการปลูกทดสอบสำเร็จ ${createdCount} แผน`);

    // ตรวจสอบข้อมูลที่สร้าง
    const checkResult = await pool.query(`
      SELECT
        id, plan_id, vegetable_type, plant_date, harvest_date,
        water_system, water_close_date, ec_value, ph_value, status
      FROM planting_plans
      WHERE status = 'pending' AND water_system = 'circulating'
      ORDER BY created_at DESC
      LIMIT 5
    `);

    console.log('\n=== แผนการปลูกระบบน้ำเวียนที่รอดำเนินการ ===');
    console.log(`จำนวน: ${checkResult.rows.length} แผน\n`);

    checkResult.rows.forEach((plan, index) => {
      console.log(`${index + 1}. ${plan.vegetable_type} (${plan.plan_id})`);
      console.log(`   📅 วันปลูก: ${plan.plant_date?.toISOString().split('T')[0]}`);
      console.log(`   🌾 วันเก็บเกี่ยว: ${plan.harvest_date?.toISOString().split('T')[0]}`);
      console.log(`   💧 วันปิดน้ำ: ${plan.water_close_date?.toISOString().split('T')[0]}`);
      console.log(`   ⚡ EC: ${plan.ec_value} | 💦 pH: ${plan.ph_value}`);
      console.log(`   📊 สถานะ: ${plan.status}\n`);
    });

    console.log('🎉 เสร็จสิ้น! สามารถดูในหน้า "Planting Plan > ต้องทำ" ได้แล้ว');

  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
  } finally {
    console.log('\n🔌 ปิดการเชื่อมต่อ');
    process.exit(0);
  }
}

createPendingPlans();
