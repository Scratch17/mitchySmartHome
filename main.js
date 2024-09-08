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
const MQTT_TEMPERATURE_TOPIC = process.env.MQTT_TEMPERATURE_TOPIC ?? 'terrarium/temperatur' //? temperaturwert als retain publishen, damit man immer den zuletzt gelesenen Wert nachschauen kann
const MQTT_LIGHT_TOPIC = process.env.MQTT_LIGHT_TOPIC ?? 'terrarium/licht' //? zum AN und AUS schalten sowie setzen neuer Zeitpläne

const sprinkler = new Gpio(GPIO_PIN_MAPPING[4], 'out')
const client = mqtt.connect(MQTT_BROKER_URL)

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
  }
}

const executeSprinklerCommand = (command, time) => {
  //todo: Möglichkeit Zeitpunkte hinzuzufügen, wann Regenanlage an gehen soll empty array soll resetten
  const gpioValue = parseInt(command)
  if (gpioValue !== 1 && gpioValue !== 0) {
    const errMessage = `Ivalid command value "${command}": "command" needs to be 1 or 0`
    console.error(errMessage)
    client.publish(
      MQTT_SPRINKLER_TOPIC,
      JSON.stringify({
        sender: THIS_MQTT_SENDER,
        message: errMessage,
      }),
      err => {
        if (err) {
          console.error(`Message could not be published: ${err}`)
        } else {
          console.log(`Error Message published`)
        }
      }
    )
  } else {
    sprinkler.writeSync(gpioValue)
    let successMessage = `Set Sprinkler to ${gpioValue}`
    console.log(successMessage)
    client.publish(
      MQTT_SPRINKLER_TOPIC,
      JSON.stringify({
        sender: THIS_MQTT_SENDER,
        message: successMessage,
      }),
      err => {
        if (err) {
          console.error(`Message could not be published: ${err}`)
        } else {
          console.log(`Success Message published`)
        }
      }
    )
    if (gpioValue === 1) {
      setTimeout(() => {
        sprinkler.writeSync(0)
        successMessage = '15s over. Set Sprinkler to 0.'
        console.log(successMessage)
        client.publish(
          MQTT_SPRINKLER_TOPIC,
          JSON.stringify({
            sender: THIS_MQTT_SENDER,
            message: successMessage,
          }),
          err => {
            if (err) {
              console.error(`Message could not be published: ${err}`)
            } else {
              console.log(`Success Message published`)
            }
          }
        )
      }, 15000)
    }
  }
}

const executeLightCommand = (command, time) => {
  //todo: fertigstellen
}

client.on('message', (topic, message) => {
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
})

process.on('SIGINT', () => {
  sprinkler.unexport()
  client.end()
  process.exit()
})

// todo: überlegen wie es als eigener Prozess immer im hintergrund laufen soll
