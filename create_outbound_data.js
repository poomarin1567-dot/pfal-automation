const { Pool } = require('pg');
const pool = new Pool({
  host: '192.168.20.50',
  port: 5432,
  user: 'postgres',
  password: '123456',
  database: 'pfal'
});

async function createOutboundData() {
  const client = await pool.connect();
  try {
    console.log('🔧 สร้างข้อมูล outbound จำลอง...');
    
    // หา completed planting plans
    const plans = await client.query(`
      SELECT id, plan_id, vegetable_type, plant_count, level_required
      FROM planting_plans 
      WHERE status = 'completed' 
      LIMIT 5
    `);
    
    console.log(`พบ ${plans.rows.length} แผนที่เสร็จแล้ว`);
    
    for (const plan of plans.rows) {
      console.log(`\n📋 สร้างข้อมูลสำหรับ Plan: ${plan.plan_id}`);
      
      // สร้าง outbound work order
      const woNumber = `WO-OUT-${Date.now()}-${plan.id}`;
      const randomFloor = Math.floor(Math.random() * 9) + 1; // ชั้น 1-9
      const randomSlot = Math.floor(Math.random() * 20) + 1; // ช่อง 1-20
      
      await client.query(`
        INSERT INTO work_orders (
          work_order_number, planting_plan_id, task_type, vegetable_type,
          plant_count, level, target_date, created_by, status, created_at, updated_at
        ) VALUES ($1, $2, 'outbound', $3, $4, $5, CURRENT_DATE, 'admin', 'completed', NOW(), NOW())
      `, [woNumber, plan.id, plan.vegetable_type, plan.plant_count, 
          plan.level_required || randomFloor]);
      
      console.log(`✅ สร้าง Outbound WO: ${woNumber} (ชั้น ${randomFloor}, ช่อง ${randomSlot})`);
      
      // สร้าง tray_inventory จำลอง
      const trayId = `TRAY-${plan.plan_id}-${Date.now()}`;
      await client.query(`
        INSERT INTO tray_inventory (
          tray_id, planting_plan_id, floor, slot, veg_type,
          plant_quantity, status, time_in, station_id
        ) VALUES ($1, $2, $3, $4, $5, $6, 'on_shelf', NOW() - INTERVAL '30 days', 1)
      `, [trayId, plan.id, randomFloor, randomSlot, 
          plan.vegetable_type, plan.plant_count]);
      
      console.log(`✅ สร้าง Tray: ${trayId}`);
      
      // สร้าง task_monitor outbound จำลอง
      await client.query(`
        INSERT INTO task_monitor (
          tray_id, action_type, floor, slot, station_id,
          status, username, created_at, completed_at
        ) VALUES ($1, 'outbound', $2, $3, 1, 'success', 'admin', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')
      `, [trayId, randomFloor, randomSlot]);
      
      console.log(`✅ สร้าง Task Monitor: outbound ${trayId}`);
    }
    
    console.log('\n🎉 สร้างข้อมูลจำลองเสร็จแล้ว!');
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

createOutboundData();