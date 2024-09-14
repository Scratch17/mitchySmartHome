import { promises as fs } from 'fs'
import path from 'path'

import { Gpio } from 'onoff'
import mqtt from 'mqtt'

const GPIO_PIN_MAPPING = {
  2: 514,
  3: 515,
  4: 516,
  5: 517,
  6: 518,
  7: 519,
  8: 520,
  9: 521,
  10: 522,
  11: 523,
  12: 524,
  13: 525,
  14: 526,
  15: 527,
  16: 528,
  17: 529,
  18: 530,
  19: 531,
  20: 532,
  21: 533,
  22: 534,
  23: 535,
  24: 536,
  25: 537,
  26: 538,
  27: 539,
}
const THIS_MQTT_SENDER = 'Terrarium'
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL ?? 'mqtt://192.168.0.25'
const MQTT_SPRINKLER_TOPIC = process.env.MQTT_SPRINKLER_TOPIC ?? 'terrarium/regenanlage' //? bekommt 1 oder 0 um sie an oder aus zu schalten. wenn eigeschaltet wird: nach max. 15s wieder ausschalten sowie setzen neuer Zeitpläne
const MQTT_TEMPERATURE_TOPIC = process.env.MQTT_TEMPERATURE_TOPIC ?? 'terrarium/temperatur'
const MQTT_LIGHT_TOPIC = process.env.MQTT_LIGHT_TOPIC ?? 'terrarium/licht' //? zum AN und AUS schalten sowie setzen neuer Zeitpläne

const SENSOR_TEMP_INSIDE = '/sys/bus/w1/devices/28-357f541f64ff/w1_slave'
const SENSOR_TEMP_OUTSIDE = '/sys/bus/w1/devices/28-e978541f64ff/w1_slave'

const sprinkler = new Gpio(GPIO_PIN_MAPPING[4], 'out')
const client = mqtt.connect(MQTT_BROKER_URL)

const publishResponse = (topic, message) => {
  client.publish(
    topic,
    JSON.stringify({
      sender: THIS_MQTT_SENDER,
      message: message,
    }),
    err => {
      if (err) {
        console.error(`Message could not be published: ${err}`)
      } else {
        console.log(`Message published`)
      }
    }
  )
}

const processMessage = (message, topic) => {
  try {
    const messageObject = JSON.parse(message)
    if (!('sender' in messageObject)) {
      throw Error('Key "sender" is missing')
    }
    return messageObject
  } catch (err) {
    const errMessage = `Ivalid Message "${message}": ${err}`
    console.error(errMessage)
    publishResponse(topic, errMessage)
  }
}

const readTemperature = async sensorFile => {
  try {
    const rawData = await fs.readFile(sensorFile, 'utf8')
    const lines = rawData.split('\n')
    if (lines[0].includes('YES')) {
      const tempIndex = lines[1].indexOf('t=')
      if (tempIndex !== -1) {
        const tempString = lines[1].substring(tempIndex + 2)
        const tempC = parseFloat(tempString) / 1000.0
        return tempC
      }
    } else {
      console.error('Error while reading temperature data.')
      publishResponse(MQTT_TEMPERATURE_TOPIC, 'Error while reading temperature data.')
    }
  } catch (err) {
    console.error(`Error while processing temperature data. ${err}`)
    publishResponse(MQTT_TEMPERATURE_TOPIC, `Error while processing temperature data. ${err}`)
  }
  return null
}

const executeSprinklerCommand = (command, time) => {
  //todo: Möglichkeit Zeitpunkte hinzuzufügen, wann Regenanlage an gehen soll empty array soll resetten
  const gpioValue = parseInt(command)
  if (gpioValue !== 1 && gpioValue !== 0) {
    const errMessage = `Ivalid command value "${command}": "command" needs to be 1 or 0`
    console.error(errMessage)
    publishResponse(MQTT_SPRINKLER_TOPIC, errMessage)
  } else {
    sprinkler.writeSync(gpioValue)
    let successMessage = `Set Sprinkler to ${gpioValue}`
    console.log(successMessage)
    publishResponse(MQTT_SPRINKLER_TOPIC, successMessage)
    if (gpioValue === 1) {
      setTimeout(() => {
        sprinkler.writeSync(0)
        successMessage = '15s over. Set Sprinkler to 0.'
        console.log(successMessage)
        publishResponse(MQTT_SPRINKLER_TOPIC, successMessage)
      }, 15000)
    }
  }
}

const executeLightCommand = (command, time) => {
  //todo: fertigstellen
}

const executeTemperatureCommand = async command => {
  let message = ''
  let temperature = ''
  try {
    switch (command) {
      case 'getTempInside':
        temperature = await readTemperature(SENSOR_TEMP_INSIDE)
        if (temperature) {
          console.log(`Inside temperature reads ${temperature}`)
          publishResponse(MQTT_TEMPERATURE_TOPIC, temperature)
        }
        break
      case 'getTempOutside':
        temperature = await readTemperature(SENSOR_TEMP_OUTSIDE)
        if (temperature) {
          console.log(`Outside temperature reads ${temperature}`)
          publishResponse(MQTT_TEMPERATURE_TOPIC, temperature)
        }
        break
      default:
        message = `Ivalid command value "${command}": "command" needs to be 'getTempInside' or 'getTempOutside'`
        console.error(message)
        publishResponse(MQTT_TEMPERATURE_TOPIC, message)
        break
    }
  } catch (err) {
    publishResponse(MQTT_TEMPERATURE_TOPIC, err)
  }
}

/**
 * Expected command formats:
 *  MQTT_SPRINKLER_TOPIC & MQTT_LIGHT_TOPIC:
 *  {"sender": "someSender", command: 1 or 0, time (optional): [04:00, 16:00]}
 *  MQTT_TEMPERATURE_TOPIC:
 *  {"sender": "someSender", command: "getTempInside" or "getTempOutside"}
 */
client.on('message', async (topic, message) => {
  const { sender, command, time } = processMessage(message, topic)
  switch (topic) {
    case MQTT_SPRINKLER_TOPIC:
      if (sender && sender !== THIS_MQTT_SENDER) {
        executeSprinklerCommand(command, time)
      }
      break
    case MQTT_LIGHT_TOPIC:
      if (sender && sender !== THIS_MQTT_SENDER) {
        executeLightCommand(command, time)
      }
      break
    case MQTT_TEMPERATURE_TOPIC:
      if (sender && sender !== THIS_MQTT_SENDER) {
        await executeTemperatureCommand(command)
      }
      break
  }
})

client.on('connect', () => {
  console.log('MQTT-Client connected')
  client.subscribe(MQTT_SPRINKLER_TOPIC, err => {
    if (err) {
      console.error(`Fehler beim Subscribe des Topics ${MQTT_SPRINKLER_TOPIC}:`, err)
    } else {
      console.log(`Topic subscribed: ${MQTT_SPRINKLER_TOPIC}`)
    }
  })
  client.subscribe(MQTT_LIGHT_TOPIC, err => {
    if (err) {
      console.error(`Fehler beim Subscribe des Topics ${MQTT_LIGHT_TOPIC}:`, err)
    } else {
      console.log(`Topic subscribed: ${MQTT_LIGHT_TOPIC}`)
    }
  })
  client.subscribe(MQTT_TEMPERATURE_TOPIC, err => {
    if (err) {
      console.error(`Fehler beim Subscribe des Topics ${MQTT_TEMPERATURE_TOPIC}:`, err)
    } else {
      console.log(`Topic subscribed: ${MQTT_TEMPERATURE_TOPIC}`)
    }
  })
})

process.on('SIGINT', () => {
  sprinkler.unexport()
  client.end()
  process.exit()
})

// todo: überlegen wie es als eigener Prozess immer im hintergrund laufen soll
