import fs from 'fs'
import { promises as afs } from 'fs'
import path from 'path'

import axios from 'axios'
import express from 'express'
import cors from 'cors'
import cron from 'node-cron'
import { Gpio } from 'onoff'
import mqtt from 'mqtt'
import promClient from 'prom-client'

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
  10: [0, 0, 255],
  11: [25, 25, 229],
  12: [51, 51, 204],
  13: [76, 76, 178],
  14: [102, 102, 153],
  15: [127, 127, 127],
  16: [153, 153, 102],
  17: [178, 178, 76],
  18: [204, 204, 51],
  19: [229, 229, 25],
  20: [255, 255, 0],
  21: [255, 255, 0],
  22: [255, 241, 0],
  23: [255, 228, 0],
  24: [255, 214, 0],
  25: [255, 201, 0],
  26: [255, 187, 0],
  27: [255, 174, 0],
  28: [255, 161, 0],
  29: [255, 147, 0],
  30: [255, 134, 0],
  31: [255, 120, 0],
  32: [255, 107, 0],
  33: [255, 93, 0],
  34: [255, 80, 0],
  35: [255, 67, 0],
  36: [255, 53, 0],
  37: [255, 40, 0],
  38: [255, 26, 0],
  39: [255, 13, 0],
  40: [255, 0, 0],
}

const THIS_MQTT_SENDER = 'Terrarium'
const MQTT_BROKER_URL = 'mqtt://192.168.0.25'
const MQTT_SPRINKLER_TOPIC = 'terrarium/regenanlage'
const MQTT_TEMPERATURE_INSIDE_TOPIC = 'terrarium/temperatur/innen'
const MQTT_TEMPERATURE_OUTSIDE_TOPIC = 'terrarium/temperatur/außen'
const MQTT_LIGHT_TOPIC = 'terrarium/licht'
const MQTT_SETTINGS_TOPIC = 'terrarium/settings'

const SENSOR_TEMP_INSIDE = '/sys/bus/w1/devices/28-357f541f64ff/w1_slave'
const SENSOR_TEMP_OUTSIDE = '/sys/bus/w1/devices/28-e978541f64ff/w1_slave'

let sprinklerTimes = config.sprinklerTimes
let sprinkleLengthMS = config.sprinkleLengthMS
let lightStart = config.lightStart
let lightEnd = config.lightEnd

const sprinkler = new Gpio(GPIO_PIN_MAPPING[4], 'out')
const client = mqtt.connect(MQTT_BROKER_URL)

const insideTemperatureGauge = new promClient.Gauge({
  name: 'inside_temperature_celsius',
  help: 'Aktuelle Innentemperatur in Celsius',
})

const outsideTemperatureGauge = new promClient.Gauge({
  name: 'outside_temperature_celsius',
  help: 'Aktuelle Raumtemperatur in Celsius',
})

const timeSchedules = {
  COLOR_CHANGE: null,
  SPRINKLER: [],
  LIGHT: {
    start: null,
    end: null,
  },
  TEMPERATURE: null,
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

const forwardToMQTT = (topic, sender, command, value = null) => {
  return new Promise((resolve, reject) => {
    client.publish(
      topic,
      JSON.stringify({
        sender: sender,
        command: command,
        value: value,
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
    const errMessage = `Invalid Message "${message}": ${err}`
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

const isTimeInPast = timeStr => {
  const [inputHours, inputMinutes] = timeStr.split(':').map(Number)
  const now = new Date()
  const inputTimeInMinutes = inputHours * 60 + inputMinutes
  const currentTimeInMinutes = now.getHours() * 60 + now.getMinutes()
  return inputTimeInMinutes < currentTimeInMinutes
}

const changeColorByTemperature = async () => {
  const temperature = await readTemperature(SENSOR_TEMP_INSIDE)
  try {
    const response = await axios.post(`http://terrariumled.local/json/state`, {
      on: isTimeInPast(lightStart) && !isTimeInPast(lightEnd),
      bri: 255,
      seg: [
        {
          col: [TEMPERATURE_COLOR_MAP[Math.round(temperature)]],
        },
      ],
    })
  } catch (error) {
    console.error(error)
    publishResponse(MQTT_LIGHT_TOPIC, error)
    return
  }
}

const initColorChangeSchedule = async () => {
  await changeColorByTemperature()
  const cronJobColorChange = cron.schedule('*/5 * * * *', changeColorByTemperature, { scheduled: true })
  timeSchedules.COLOR_CHANGE = cronJobColorChange
  console.log(`Initiated automatic color change`)
}

const initTemperatureSchedule = async () => {
  const insideTemp = await readTemperature(SENSOR_TEMP_INSIDE)
  const outsideTemp = await readTemperature(SENSOR_TEMP_OUTSIDE)
  insideTemperatureGauge.set(insideTemp)
  outsideTemperatureGauge.set(outsideTemp)
  const cronJobTemperatureChange = cron.schedule(
    '*/3 * * * *',
    async () => {
      const insideTemp = await readTemperature(SENSOR_TEMP_INSIDE)
      const outsideTemp = await readTemperature(SENSOR_TEMP_OUTSIDE)
      insideTemperatureGauge.set(insideTemp)
      outsideTemperatureGauge.set(outsideTemp)
    },
    { scheduled: true }
  )
  timeSchedules.TEMPERATURE = cronJobTemperatureChange
  console.log(`Initiated automatic temperature read`)
}

const initLightSchedule = async () => {
  const cronJobLightStart = cron.schedule(
    timeToCron(lightStart),
    async () => {
      message = 'Turning light on'
      try {
        await axios.post(`http://terrariumled.local/json/state`, { on: true })
      } catch (error) {
        console.error(error)
        publishResponse(MQTT_LIGHT_TOPIC, error)
        return
      }
      console.log(message)
      publishResponse(MQTT_LIGHT_TOPIC, message)
    },
    { scheduled: true }
  )
  timeSchedules.LIGHT.start = cronJobLightStart
  console.log(`Initiated light start job for ${lightStart}`)
  const cronJobLightEnd = cron.schedule(
    timeToCron(lightEnd),
    async () => {
      message = 'Turning light off'
      try {
        await axios.post(`http://terrariumled.local/json/state`, { on: false })
      } catch (error) {
        console.error(error)
        publishResponse(MQTT_LIGHT_TOPIC, error)
        return
      }
      console.log(message)
      publishResponse(MQTT_LIGHT_TOPIC, message)
    },
    { scheduled: true }
  )
  timeSchedules.LIGHT.end = cronJobLightEnd
  console.log(`Initiated light stop job for ${lightEnd}`)
  if (!isTimeInPast(lightStart) && !isTimeInPast(lightEnd)) await executeLightCommand(0)
  if (isTimeInPast(lightStart) && !isTimeInPast(lightEnd)) await executeLightCommand(1)
  if (isTimeInPast(lightStart) && isTimeInPast(lightEnd)) await executeLightCommand(0)
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
        async () => {
          message = 'Turning light on'
          try {
            await axios.post(`http://terrariumled.local/json/state`, { on: true })
          } catch (error) {
            console.error(error)
            publishResponse(MQTT_LIGHT_TOPIC, error)
            return
          }
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
        async () => {
          message = 'Turning light off'
          try {
            await axios.post(`http://terrariumled.local/json/state`, { on: false })
          } catch (error) {
            console.error(error)
            publishResponse(MQTT_LIGHT_TOPIC, error)
            return
          }
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
      message = `Invalid command value "${command}": "command" needs to be 1 (on) or 0 (off)`
      console.error(message)
      publishResponse(MQTT_SPRINKLER_TOPIC, message)
  }
}

const executeLightCommand = async command => {
  const ledValue = parseInt(command)
  let message = ''
  switch (ledValue) {
    case 1:
      message = 'Turning light on'
      try {
        await axios.post(`http://terrariumled.local/json/state`, { on: true })
      } catch (error) {
        console.error(error)
        publishResponse(MQTT_LIGHT_TOPIC, error)
        break
      }
      console.log(message)
      publishResponse(MQTT_LIGHT_TOPIC, message)
      break
    case 0:
      message = 'Turning light off'
      try {
        await axios.post(`http://terrariumled.local/json/state`, { on: false })
      } catch (error) {
        console.error(error)
        publishResponse(MQTT_LIGHT_TOPIC, error)
        break
      }
      console.log(message)
      publishResponse(MQTT_LIGHT_TOPIC, message)
      break
    default:
      message = `Invalid command value "${command}": "command" needs to be 1 (on) or 0 (off)`
      console.error(message)
      publishResponse(MQTT_LIGHT_TOPIC, message)
  }
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
        message = `Light will turn on at ${value}`
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
        message = `Light will turn off at ${value}`
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
      message = `Invalid command value "${command}": "command" needs to be "setSprinklerTimes", "setSprinkleLengthMS", "setLightStart", "setLightEnd" or "getSettings"`
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
      await executeLightCommand(command)
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
initColorChangeSchedule()
initTemperatureSchedule()

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

server.get('/api/temperatur/:type', async (req, res) => {
  const sender = req.params.sender
  const type = req.params.type
  let temperature = null
  switch (type) {
    case 'innen':
      temperature = await readTemperature(SENSOR_TEMP_INSIDE)
      break
    case 'aussen':
      temperature = await readTemperature(SENSOR_TEMP_OUTSIDE)
      break
    default:
      return res.status(400).json({ success: false, hint: 'invalid type attribute. Needs to be "innen" or "aussen".' })
  }
  res.json({ success: true, temperature: temperature })
})

server.get('/api/licht/:sender/:command', async (req, res) => {
  const sender = req.params.sender
  const command = req.params.command
  const success = await forwardToMQTT(MQTT_LIGHT_TOPIC, sender, command)
  res.json({ success: success, hint: 'If nothing happens, please check MQTT for errors.' })
})

server.put('/api/settings/:sender/:command', async (req, res) => {
  const sender = req.params.sender
  const command = req.params.command
  let value = req.body
  const timePattern = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/
  switch (command) {
    case 'setSprinklerTimes':
      if (
        !Object.is(value) ||
        !value.every(time => typeof time === 'string') ||
        !value.every(time => timePattern.test(time))
      ) {
        return res.status(400).json({ error: `Invalid time format. Please use hh:mm in 24h format` })
      }
      break
    case 'setSprinkleLengthMS':
      if (!value.hasOwnProperty('sprinkleLengthMS') || !typeof value.sprinkleLengthMS === 'number') {
        return res
          .status(400)
          .json({ error: `Invalid value. Body needs to have "sprinkleLengthMS" key with a numerical value.` })
      }
      value = req.body.sprinkleLengthMS
      break
    case 'setLightStart':
      if (!value.hasOwnProperty('lightStart') || !timePattern.test(value.lightStart)) {
        return res
          .status(400)
          .json({ error: `Invalid value. Body needs to have "lightStart" key with a hh:mm in 24h format string.` })
      }
      value = req.body.lightStart
      break
    case 'setLightEnd':
      if (!value.hasOwnProperty('lightEnd') || !timePattern.test(value.lightEnd)) {
        return res
          .status(400)
          .json({ error: `Invalid value. Body needs to have "lightEnd" key with a hh:mm in 24h format string.` })
      }
      value = req.body.lightEnd
      break
    default:
      return res.status(400).json({
        success: false,
        hint: `Invalid command value "${command}": Needs to be "setSprinklerTimes", "setSprinkleLengthMS", "setLightStart" or "setLightEnd"`,
      })
  }
  const success = await forwardToMQTT(MQTT_SETTINGS_TOPIC, sender, command, value)
  res.json({
    success: success,
  })
})

server.get('/api/settings', async (req, res) => {
  res.json(JSON.parse(fs.readFileSync('./config.json', 'utf8')))
})

server.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType)
  res.end(await promClient.register.metrics())
})

server.listen(PORT, () => {
  console.log(`Server started. Listeing on port ${PORT}`)
})

//todo: Code aufräumen
