import fs from 'fs'
import { promises as afs } from 'fs'
import path from 'path'

import express from 'express'
import cors from 'cors'
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

const TEMPERATURE_COLOR_MAP = {
  10: { hue: 0.3, sat: 0.54, val: 0.1 },
  11: { hue: 0.26, sat: 0.62, val: 0.1 },
  12: { hue: 0.23, sat: 0.7, val: 0.1 },
  13: { hue: 0.21, sat: 0.78, val: 0.1 },
  14: { hue: 0.19, sat: 0.86, val: 0.1 },
  15: { hue: 0.16, sat: 1, val: 0.1 },
  16: { hue: 0.16, sat: 1, val: 0.1 },
  17: { hue: 0.15, sat: 1, val: 0.1 },
  18: { hue: 0.14, sat: 1, val: 0.1 },
  19: { hue: 0.14, sat: 1, val: 0.1 },
  20: { hue: 0.13, sat: 1, val: 0.1 },
  21: { hue: 0.12, sat: 1, val: 0.1 },
  22: { hue: 0.12, sat: 1, val: 0.1 },
  23: { hue: 0.11, sat: 1, val: 0.1 },
  24: { hue: 0.1, sat: 1, val: 0.1 },
  25: { hue: 0.1, sat: 1, val: 0.1 },
  26: { hue: 0.09, sat: 1, val: 0.1 },
  27: { hue: 0.08, sat: 1, val: 0.1 },
  28: { hue: 0.08, sat: 1, val: 0.1 },
  29: { hue: 0.07, sat: 1, val: 0.1 },
  30: { hue: 0.06, sat: 1, val: 0.1 },
  31: { hue: 0.06, sat: 1, val: 0.1 },
  32: { hue: 0.05, sat: 1, val: 0.1 },
  33: { hue: 0.04, sat: 1, val: 0.1 },
  34: { hue: 0.04, sat: 1, val: 0.1 },
  35: { hue: 0.03, sat: 1, val: 0.1 },
  36: { hue: 0.02, sat: 1, val: 0.1 },
  37: { hue: 0.02, sat: 1, val: 0.1 },
  38: { hue: 0.01, sat: 1, val: 0.1 },
  39: { hue: 0, sat: 1, val: 0.1 },
  40: { hue: 0, sat: 1, val: 0.1 },
}

const THIS_MQTT_SENDER = 'Terrarium'
const MQTT_BROKER_URL = 'mqtt://192.168.0.25'
const MQTT_SPRINKLER_TOPIC = 'terrarium/regenanlage'
const MQTT_TEMPERATURE_INSIDE_TOPIC = 'terrarium/temperatur/innen'
const MQTT_TEMPERATURE_OUTSIDE_TOPIC = 'terrarium/temperatur/außen'
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
        console.error(`Answer could not be published: ${err}`)
      } else {
        console.log(`Answer published`)
      }
    }
  )
}

const forwardToMQTT = (topic, sender, command, time = null) => {
  return new Promise((resolve, reject) => {
    client.publish(
      topic,
      JSON.stringify({
        sender: sender,
        command: command,
        time: time,
      }),
      err => {
        if (err) {
          console.error(`Forward could not be published: ${err}`)
          reject(false)
        } else {
          console.log(`Forward published`)
          resolve(true)
        }
      }
    )
  })
}

const timeToCron = time => {
  const timePattern = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/
  if (!timePattern.test(time)) {
    throw new Error(`Invalid time format: ${time}. Please use hh:mm in 24h format`)
  }
  const [hours, minutes] = time.split(':')
  return `${minutes} ${hours} * * *`
}

const updateConfig = () => {
  const newConfigData = JSON.parse(fs.readFileSync('./config.json', 'utf8'))
  newConfigData.sprinklerTimes = sprinklerTimes
  newConfigData.sprinkleLengthMS = sprinkleLengthMS
  newConfigData.lightStart = lightStart
  newConfigData.lightEnd = lightEnd
  fs.writeFileSync('./config.json', JSON.stringify(newConfigData, null, 2), 'utf8')
  console.log('Updated config.json file')
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
    case 'LIGHT_START':
      timeSchedules['LIGHT'].start.stop()
      timeSchedules['LIGHT'].start = null
      break
    case 'LIGHT_END':
      timeSchedules['LIGHT'].end.stop()
      timeSchedules['LIGHT'].end = null
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

const initLightSchedule = () => {
  const cronJobLightStart = cron.schedule(
    timeToCron(lightStart),
    () => {
      // todo: WLED an schalten
      message = 'Turning light on'
      console.log(message)
      publishResponse(MQTT_LIGHT_TOPIC, message)
    },
    { scheduled: true }
  )
  timeSchedules.LIGHT.start = cronJobLightStart
  console.log(`Initiated light start job for ${lightStart}`)
  const cronJobLightEnd = cron.schedule(
    timeToCron(lightEnd),
    () => {
      // todo: WLED an schalten
      message = 'Turning light off'
      console.log(message)
      publishResponse(MQTT_LIGHT_TOPIC, message)
    },
    { scheduled: true }
  )
  timeSchedules.LIGHT.end = cronJobLightEnd
  console.log(`Initiated light start job for ${lightEnd}`)
}

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

const setLightSchedule = (startOrEnd, cronTime) => {
  unsetSchedule(startOrEnd)
  let message = ''
  let cronJob = null
  switch (startOrEnd) {
    case 'LIGHT_START':
      cronJob = cron.schedule(
        cronTime,
        () => {
          // todo: WLED an schalten
          message = 'Turning light on'
          console.log(message)
          publishResponse(MQTT_LIGHT_TOPIC, message)
        },
        { scheduled: true }
      )
      timeSchedules.LIGHT.start = cronJob
      break
    case 'LIGHT_END':
      cronJob = cron.schedule(
        cronTime,
        () => {
          // todo: WLED aus schalten
          message = 'Turning light off'
          console.log(message)
          publishResponse(MQTT_LIGHT_TOPIC, message)
        },
        { scheduled: true }
      )
      timeSchedules.LIGHT.end = cronJob
      break
    default:
      message = 'Sth went wrong scheduling light times :('
      console.log(message)
      publishResponse(MQTT_LIGHT_TOPIC, message)
  }
}

const executeSprinklerCommand = command => {
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
    default:
      message = `Ivalid command value "${command}": "command" needs to be 1 (on) or 0 (off)`
      console.error(message)
      publishResponse(MQTT_SPRINKLER_TOPIC, message)
  }
}

const executeLightCommand = command => {
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

const executeSettingsCommand = (command, value) => {
  let message = ''
  switch (command) {
    case 'setSprinklerTimes':
      if (!value) {
        message = 'No times found to set'
        console.error(message)
        publishResponse(MQTT_SETTINGS_TOPIC, message)
        break
      }
      if (!Array.isArray(value)) {
        message = 'Invalid time value. time has to be an array with hh:mm format values'
        console.error(message)
        publishResponse(MQTT_SETTINGS_TOPIC, message)
        break
      }
      try {
        const cronTimes = value.map(t => timeToCron(t))
        setSprinklerSchedule(cronTimes)
        sprinklerTimes = value
        updateConfig()
        message = 'Successfully set new times'
        console.log(message)
        publishResponse(MQTT_SETTINGS_TOPIC, message)
      } catch (err) {
        console.error(err)
        publishResponse(MQTT_SETTINGS_TOPIC, err.toString())
      }
      break
    case 'setSprinkleLengthMS':
      if (!value) {
        message = 'No time found to set'
        console.error(message)
        publishResponse(MQTT_SETTINGS_TOPIC, message)
        break
      }
      if (typeof value !== 'number') {
        message = 'Invalid millisecond value. time has to be numerical.'
        console.error(message)
        publishResponse(MQTT_SETTINGS_TOPIC, message)
        break
      }
      try {
        sprinkleLengthMS = value
        updateConfig()
        message = `Sprinkler now will sprinkle ${sprinkleLengthMS / 1000} seconds.`
        console.log(message)
        publishResponse(MQTT_SETTINGS_TOPIC, message)
      } catch (err) {
        console.error(err)
        publishResponse(MQTT_SETTINGS_TOPIC, err.toString())
      }
      break
    case 'setLightStart':
      if (!value) {
        message = 'No time found to set'
        console.error(message)
        publishResponse(MQTT_SETTINGS_TOPIC, message)
        break
      }
      if (typeof value !== 'string') {
        message = 'Invalid time value. time has to be a string with hh:mm format'
        console.error(message)
        publishResponse(MQTT_SETTINGS_TOPIC, message)
        break
      }
      try {
        const cronTimeLightStart = timeToCron(value)
        setLightSchedule('LIGHT_START', cronTimeLightStart)
        lightStart = value
        updateConfig()
        message = `Light will start now at ${value}`
        console.log(message)
        publishResponse(MQTT_SETTINGS_TOPIC, message)
      } catch (err) {
        console.error(err)
        publishResponse(MQTT_SETTINGS_TOPIC, err.toString())
      }
      break
    case 'setLightEnd':
      if (!value) {
        message = 'No time found to set'
        console.error(message)
        publishResponse(MQTT_SETTINGS_TOPIC, message)
        break
      }
      if (typeof value !== 'string') {
        message = 'Invalid time value. time has to be a string with hh:mm format'
        console.error(message)
        publishResponse(MQTT_SETTINGS_TOPIC, message)
        break
      }
      try {
        const cronTimeLightEnd = timeToCron(value)
        setLightSchedule('LIGHT_END', cronTimeLightEnd)
        lightEnd = value
        updateConfig()
        message = `Light will end now at ${value}`
        console.log(message)
        publishResponse(MQTT_SETTINGS_TOPIC, message)
      } catch (err) {
        console.error(err)
        publishResponse(MQTT_SETTINGS_TOPIC, err.toString())
      }
      break
    case 'getSettings':
      publishResponse(MQTT_SETTINGS_TOPIC, {
        sprinklerTimes: sprinklerTimes,
        sprinkleLengthMS: sprinkleLengthMS,
        lightStart: lightStart,
        lightEnd: lightEnd,
      })
      break
    default:
      message = `Ivalid command value "${command}": "command" needs to be "setSprinklerTimes", "setSprinkleLengthMS", "setLightStart", "setLightEnd" or "getSettings"`
      console.error(message)
      publishResponse(MQTT_SETTINGS_TOPIC, message)
  }
}

const executeTemperatureCommand = async (type, topic) => {
  let message = ''
  let temperature = ''
  try {
    switch (type) {
      case 'inside':
        temperature = await readTemperature(SENSOR_TEMP_INSIDE)
        if (temperature) {
          console.log(`Inside temperature reads ${temperature}`)
          publishResponse(topic, temperature)
        }
        break
      case 'outside':
        temperature = await readTemperature(SENSOR_TEMP_OUTSIDE)
        if (temperature) {
          console.log(`Outside temperature reads ${temperature}`)
          publishResponse(topic, temperature)
        }
        break
      default:
        message = `Something went wrong :(`
        console.error(message)
        publishResponse(topic, message)
    }
  } catch (err) {
    console.error(err)
    publishResponse(topic, err)
  }
}

/**
 * Expected command formats:
 *  MQTT_SPRINKLER_TOPIC:
 *  {"sender": "someSender", command: 1 or 0}
 *  MQTT_LIGHT_TOPIC:
 *  {"sender": "someSender", command: 1 or 0}
 *  MQTT_TEMPERATURE_INSIDE_TOPIC & MQTT_TEMPERATURE_OUTSIDE_TOPIC:
 *  {"sender": "someSender"}
 *  MQTT_SETTINGS_TOPIC:
 *  {"sender": "someSender", command: "setSetting", value: "acceptedValue"}
 */
client.on('message', async (topic, message) => {
  const { sender, command, value } = processMessage(message, topic)
  if (sender && sender === THIS_MQTT_SENDER) {
    return
  }
  switch (topic) {
    case MQTT_SPRINKLER_TOPIC:
      executeSprinklerCommand(command)
      break
    case MQTT_LIGHT_TOPIC:
      executeLightCommand(command)
      break
    case MQTT_TEMPERATURE_INSIDE_TOPIC:
      await executeTemperatureCommand('inside', MQTT_TEMPERATURE_INSIDE_TOPIC)
      break
    case MQTT_TEMPERATURE_OUTSIDE_TOPIC:
      await executeTemperatureCommand('outside', MQTT_TEMPERATURE_OUTSIDE_TOPIC)
      break
    case MQTT_SETTINGS_TOPIC:
      executeSettingsCommand(command, value)
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
  client.subscribe(MQTT_TEMPERATURE_INSIDE_TOPIC, err => {
    if (err) {
      console.error(`Fehler beim Subscribe des Topics ${MQTT_TEMPERATURE_INSIDE_TOPIC}:`, err)
    } else {
      console.log(`Topic subscribed: ${MQTT_TEMPERATURE_INSIDE_TOPIC}`)
    }
  })
  client.subscribe(MQTT_TEMPERATURE_OUTSIDE_TOPIC, err => {
    if (err) {
      console.error(`Fehler beim Subscribe des Topics ${MQTT_TEMPERATURE_OUTSIDE_TOPIC}:`, err)
    } else {
      console.log(`Topic subscribed: ${MQTT_TEMPERATURE_OUTSIDE_TOPIC}`)
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

const server = express()
server.set('trust proxy', 1)
server.use(cors())
server.use(express.static('www'))
server.use(express.json())

const PORT = 17000

server.get('/api/regenanlage/:sender/:command', async (req, res) => {
  const sender = req.params.sender
  const command = req.params.command
  const success = await forwardToMQTT(MQTT_SPRINKLER_TOPIC, sender, command)
  res.json({ success: success, hint: 'If nothing happens, please check MQTT for errors.' })
})

//! outdated. Muss auf settings api angepasst werden
server.put('/api/regenanlage/:sender/time', async (req, res) => {
  const sender = req.params.sender
  const sprinklerTimes = req.body

  const timePattern = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/
  if (
    !Array.isArray(sprinklerTimes) ||
    !sprinklerTimes.every(time => typeof time === 'string') ||
    !sprinklerTimes.every(time => timePattern.test(time))
  ) {
    return res.status(400).json({ error: `Invalid time format. Please use hh:mm in 24h format` })
  }

  const success = await forwardToMQTT(MQTT_SPRINKLER_TOPIC, sender, -1, sprinklerTimes)
  res.json({ success: success, hint: 'If nothing happens, please check MQTT for errors.' })
})

// server.get('/api/licht/:sender/:command', async (req, res) => {})

// server.get('/api/temperatur/:sender/:command', async (req, res) => {})

// server.get('/api/settings/:sender', async (req, res) => {})

server.listen(PORT, () => {
  console.log(`Server started. Listeing on port ${PORT}`)
})

//todos:
//todo: 1. Licht
//todo: 2. Zeiteinstellung für Licht
//todo: 3. Prometheus aufsetzen und anbinden
