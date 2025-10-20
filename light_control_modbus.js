// ===============================================
// 💡 ระบบควบคุมแสงสว่างด้วย Modbus RTU
// ===============================================

// ✅ Modbus RTU Class สำหรับสร้าง Frame
class ModbusSlave {
    constructor(id) {
        this.id = id;
    }

    // คำนวณ CRC16 สำหรับ Modbus RTU
    crc16(buffer) {
        let crc = 0xFFFF;
        for (let pos = 0; pos < buffer.length; pos++) {
            crc ^= buffer[pos];
            for (let i = 8; i !== 0; i--) {
                if ((crc & 0x0001) !== 0) {
                    crc >>= 1;
                    crc ^= 0xA001;
                } else {
                    crc >>= 1;
                }
            }
        }
        return [(crc & 0xFF), (crc >> 8)];
    }

    // แปลงเลข 16-bit เป็น 2 bytes (High, Low)
    int16To8(inputNumber) {
        return [(inputNumber >> 8) & 0xFF, inputNumber & 0xFF];
    }

    // สร้าง Modbus RTU Frame สำหรับ READ (Function Code 0x03, 0x04)
    modbusRTUGenerator(functionCode, startAddress, numOfRegister) {
        const addressBytes = this.int16To8(startAddress);
        const registerBytes = this.int16To8(numOfRegister);

        const frame = [
            this.id,
            functionCode,
            ...addressBytes,
            ...registerBytes
        ];

        const crc = this.crc16(frame);
        return [...frame, ...crc];
    }

    // สร้าง Modbus RTU Frame สำหรับ WRITE (Function Code 0x05, 0x06)
    modbusWriteRTUGenerator(functionCode, startAddress, data) {
        const addressBytes = this.int16To8(startAddress);
        const dataBytes = this.int16To8(data);

        const frame = [
            this.id,
            functionCode,
            ...addressBytes,
            ...dataBytes
        ];

        const crc = this.crc16(frame);
        return [...frame, ...crc];
    }
}

// ✅ การตั้งค่า Light Control
const LIGHT_CONTROL_CONFIG = {
    // Slave ID สำหรับแต่ละชั้น (7 ชั้น)
    SLAVE_IDS: {
        1: 0x01,
        2: 0x02,
        3: 0x03,
        4: 0x04,
        5: 0x05,
        6: 0x06,
        7: 0x07
    },

    // Register สำหรับ LED (9 ช่อง) - Odd registers
    LED_REGISTERS: [1, 3, 5, 7, 9, 11, 13, 15, 17],

    // Register สำหรับ Fan (9 ช่อง)
    FAN_REGISTERS: [101, 103, 105, 107, 109, 111, 113, 115, 117],

    // Function Codes
    FC: {
        READ_HOLDING: 0x03,
        READ_INPUT: 0x04,
        WRITE_COIL: 0x05,
        WRITE_REGISTER: 0x06
    },

    // MQTT Topics
    MQTT_TOPIC: 'factory/modbus/light_control'
};

// ✅ ฟังก์ชันแปลง Light ID เป็น Register Address
function getLightRegisterAddress(lightId, deviceType) {
    // lightId format: "L1-1" = ชั้น 1 ตำแหน่ง 1
    const match = lightId.match(/L(\d+)-(\d+)/);
    if (!match) return null;

    const floor = parseInt(match[1]);
    const position = parseInt(match[2]);

    // position 1-9 -> index 0-8
    const index = position - 1;

    if (deviceType === 'whiteLight' || deviceType === 'redLight') {
        // ใช้ LED_REGISTERS (ยังไม่แน่ใจว่า white/red แยกกันอย่างไร)
        // Map ไว้ก่อน จะปรับหน้างาน
        return LIGHT_CONTROL_CONFIG.LED_REGISTERS[index];
    } else if (deviceType === 'fan') {
        return LIGHT_CONTROL_CONFIG.FAN_REGISTERS[index];
    }

    return null;
}

// ✅ ฟังก์ชันส่งคำสั่ง Modbus ผ่าน MQTT
function sendModbusCommand(mqttClient, floor, lightId, deviceType, intensity) {
    const slaveId = LIGHT_CONTROL_CONFIG.SLAVE_IDS[floor];
    if (!slaveId) {
        console.error(`❌ Invalid floor: ${floor}`);
        return;
    }

    const registerAddress = getLightRegisterAddress(lightId, deviceType);
    if (registerAddress === null) {
        console.error(`❌ Invalid light register: ${lightId}, ${deviceType}`);
        return;
    }

    // สร้าง Modbus Slave instance
    const slave = new ModbusSlave(slaveId);

    // สร้าง Frame สำหรับเขียนค่า (Function Code 0x06 = Write Single Register)
    const modbusFrame = slave.modbusWriteRTUGenerator(
        LIGHT_CONTROL_CONFIG.FC.WRITE_REGISTER,
        registerAddress,
        intensity
    );

    // แปลงเป็น Hex String สำหรับส่งผ่าน MQTT
    const hexString = modbusFrame.map(b => b.toString(16).padStart(2, '0')).join('');

    const mqttPayload = JSON.stringify({
        slaveId: slaveId,
        register: registerAddress,
        value: intensity,
        modbusFrame: hexString,
        timestamp: new Date().toISOString()
    });

    // ส่งผ่าน MQTT
    mqttClient.publish(LIGHT_CONTROL_CONFIG.MQTT_TOPIC, mqttPayload);

    console.log(`📤 Modbus Command >> Floor:${floor}, Light:${lightId}, Device:${deviceType}, Intensity:${intensity}`);
    console.log(`   Modbus Frame: ${hexString}`);
}

module.exports = {
    ModbusSlave,
    LIGHT_CONTROL_CONFIG,
    getLightRegisterAddress,
    sendModbusCommand
};
