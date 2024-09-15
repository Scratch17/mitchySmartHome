import fs from 'fs'
import { promises as afs } from 'fs'
import path from 'path'

import cron from 'node-cron'
import { Gpio } from 'onoff'
import mqtt from 'mqtt'

import config from './config.json' with { type: 'json' }

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
const MQTT_BROKER_URL = 'mqtt://192.168.0.25'
const MQTT_SPRINKLER_TOPIC = 'terrarium/regenanlage' //? bekommt 1 oder 0 um sie an oder aus zu schalten. wenn eigeschaltet wird: nach max. 15s wieder ausschalten sowie setzen neuer Zeitpläne
const MQTT_TEMPERATURE_TOPIC = 'terrarium/temperatur'
const MQTT_LIGHT_TOPIC = 'terrarium/licht' //? zum AN und AUS schalten sowie setzen neuer Zeitpläne
const MQTT_SETTINGS_TOPIC = 'terrarium/settings'

const SENSOR_TEMP_INSIDE = '/sys/bus/w1/devices/28-357f541f64ff/w1_slave'
const SENSOR_TEMP_OUTSIDE = '/sys/bus/w1/devices/28-e978541f64ff/w1_slave'

let sprinklerTimes = config.sprinklerTimes
let sprinkleLengthMS = config.sprinkleLengthMS
let lightStart = config.lightStart
let lightEnd = config.lightEnd

const sprinkler = new Gpio(GPIO_PIN_MAPPING[4], 'out')
const client = mqtt.connect(MQTT_BROKER_URL)

const timeSchedules = {
  SPRINKLER: [],
  LIGHT: {
    start: null,
    end: null,
  },
}

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

const timeToCron = time => {
  const timePattern = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/
  if (!timePattern.test(time)) {
    throw new Error(`Invalid time format: ${time}. Please use hh:mm in 24h format`)
  }
  const [hours, minutes] = time.split(':')
  return `${minutes} ${hours} * * *`
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
    return {}
  }
}

const readTemperature = async sensorFile => {
  try {
    const rawData = await afs.readFile(sensorFile, 'utf8')
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

const unsetSchedule = subject => {
  switch (subject) {
    case 'SPRINKLER':
      for (const cronJob of timeSchedules[subject]) {
        cronJob.stop()
      }
      timeSchedules[subject] = []
      break
    case 'LIGHT':
      timeSchedules[subject].start.stop()
      timeSchedules[subject].end.stop()
      timeSchedules[subject].start = null
      timeSchedules[subject].end = null
      break
    default:
      console.error(`subject ${subject} not found in timeSchedules`)
  }
}

const initSprinklerSchedule = () => {
  for (const time of sprinklerTimes) {
    const cronTime = timeToCron(time)
    const cronJob = cron.schedule(
      cronTime,
      () => {
        let message = ''
        sprinkler.writeSync(1)
        message = 'Start sprinkling'
        console.log(message)
        publishResponse(MQTT_SPRINKLER_TOPIC, message)
        setTimeout(() => {
          sprinkler.writeSync(0)
          message = 'Stop sprinkling'
          console.log(message)
          publishResponse(MQTT_SPRINKLER_TOPIC, message)
        }, sprinkleLengthMS)
      },
      { scheduled: true }
    )
    timeSchedules.SPRINKLER.push(cronJob)
    console.log(`Initiated sprinkler job for ${time}`)
  }
}

const initLightSchedule = () => {}

const setSprinklerSchedule = times => {
  unsetSchedule('SPRINKLER')
  for (const time of times) {
    const cronJob = cron.schedule(
      time,
      () => {
        let message = ''
        sprinkler.writeSync(1)
        message = 'Start sprinkling'
        console.log(message)
        publishResponse(MQTT_SPRINKLER_TOPIC, message)
        setTimeout(() => {
          sprinkler.writeSync(0)
          message = 'Stop sprinkling'
          console.log(message)
          publishResponse(MQTT_SPRINKLER_TOPIC, message)
        }, sprinkleLengthMS)
      },
      { scheduled: true }
    )
    timeSchedules.SPRINKLER.push(cronJob)
  }
}

const setLightSchedule = (startTime, endTime) => {}

const executeSprinklerCommand = (command, time) => {
  const gpioValue = parseInt(command)
  let message = ''
  switch (gpioValue) {
    case 1:
      sprinkler.writeSync(gpioValue)
      message = 'Start sprinkling'
      console.log(message)
      publishResponse(MQTT_SPRINKLER_TOPIC, message)
      setTimeout(() => {
        sprinkler.writeSync(0)
        message = 'Stop sprinkling'
        console.log(message)
        publishResponse(MQTT_SPRINKLER_TOPIC, message)
      }, sprinkleLengthMS)
      break
    case 0:
      sprinkler.writeSync(gpioValue)
      message = 'Stop sprinkling'
      console.log(message)
      publishResponse(MQTT_SPRINKLER_TOPIC, message)
      break
    case -1:
      if (!time) {
        message = 'No times found to set'
        console.error(message)
        publishResponse(MQTT_SPRINKLER_TOPIC, message)
        break
      }
      if (!Array.isArray(time)) {
        message = 'Invalid time value. time has to be an array with hh:mm format values'
        console.error(message)
        publishResponse(MQTT_SPRINKLER_TOPIC, message)
        break
      }
      try {
        const cronTimes = time.map(t => timeToCron(t))
        setSprinklerSchedule(cronTimes)

        // update settings
        const newConfigData = JSON.parse(fs.readFileSync('./config.json', 'utf8'))
        newConfigData.sprinklerTimes = time
        fs.writeFileSync('./config.json', JSON.stringify(newConfigData, null, 2), 'utf8')
        console.log('Updated config.json file')
        sprinklerTimes = time

        message = 'Successfully set new times'
        console.log(message)
        publishResponse(MQTT_SPRINKLER_TOPIC, message)
      } catch (err) {
        console.error(err)
        publishResponse(MQTT_SPRINKLER_TOPIC, err.toString())
      }
      break
    default:
      message = `Ivalid command value "${command}": "command" needs to be 1 (on) or 0 (off) or -1 (setTime)`
      console.error(message)
      publishResponse(MQTT_SPRINKLER_TOPIC, message)
  }
}

const executeLightCommand = (command, time) => {
  //todo: fertigstellen
  // let [startTime, endTime] = time
  // startTime = timeToCron(startTime)
  // endTime = timeToCron(endTime)
  // if (!Array.isArray(time) && !time.length === 2) {
  //   message = 'Invalid time value. time has to be an array with exactly 2 values: [startTime, endTime]'
  //   console.error(message)
  //   publishResponse(MQTT_SPRINKLER_TOPIC, message)
  //   break
  // }
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
 *  MQTT_SPRINKLER_TOPIC:
 *  {"sender": "someSender", command: 1 or 0, time (optional): [04:00, 16:00]}
 *  MQTT_LIGHT_TOPIC:
 *  {"sender": "someSender", command: 1 or 0, time (optional): [04:00 (start), 16:00 (end)]}
 *  MQTT_TEMPERATURE_TOPIC:
 *  {"sender": "someSender", command: "getTempInside" or "getTempOutside"}
 */
client.on('message', async (topic, message) => {
  const { sender, command, time } = processMessage(message, topic)
  if (sender && sender === THIS_MQTT_SENDER) {
    return
  }
  switch (topic) {
    case MQTT_SPRINKLER_TOPIC:
      executeSprinklerCommand(command, time)
      break
    case MQTT_LIGHT_TOPIC:
      executeLightCommand(command, time)
      break
    case MQTT_TEMPERATURE_TOPIC:
      await executeTemperatureCommand(command)
      break
    case MQTT_SETTINGS_TOPIC:
      publishResponse(MQTT_SETTINGS_TOPIC, {
        sprinklerTimes: sprinklerTimes,
        sprinkleLengthMS: sprinkleLengthMS,
        lightStart: lightStart,
        lightEnd: lightEnd,
      })

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
  client.subscribe(MQTT_SETTINGS_TOPIC, err => {
    if (err) {
      console.error(`Fehler beim Subscribe des Topics ${MQTT_SETTINGS_TOPIC}:`, err)
    } else {
      console.log(`Topic subscribed: ${MQTT_SETTINGS_TOPIC}`)
    }
  })
})

process.on('SIGINT', () => {
  sprinkler.unexport()
  client.end()
  process.exit()
})

initSprinklerSchedule()
initLightSchedule()

//todos:
//todo: 1. Licht
//todo: 2. Zeiteinstellung für Licht
//todo: 3. Prometheus aufsetzen und anbinden
