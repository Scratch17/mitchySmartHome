import { promises as fs } from 'fs';
import path from 'path';

// Pfade zu den 1-Wire Bus-Verzeichnissen
const baseDirs = [
  '/sys/bus/w1/devices/w1_bus_master1/',
  '/sys/bus/w1/devices/w1_bus_master2/'
];

// Funktion zum Lesen der rohen Temperaturdaten aus dem `w1_slave`-File
const readTempRaw = async (deviceFolder) => {
  try {
    const data = await fs.readFile(path.join(deviceFolder, 'w1_slave'), 'utf8');
    return data;
  } catch (error) {
    throw new Error(`Fehler beim Lesen der Datei: ${error}`);
  }
};

// Funktion zum Verarbeiten der rohen Daten und Extrahieren der Temperatur
const readTemp = async (deviceFolder) => {
  try {
    const rawData = await readTempRaw(deviceFolder);
    const lines = rawData.split('\n');

    // Überprüfen, ob die Daten gültig sind
    if (lines[0].includes('YES')) {
      const tempIndex = lines[1].indexOf('t=');
      if (tempIndex !== -1) {
        const tempString = lines[1].substring(tempIndex + 2);
        const tempC = parseFloat(tempString) / 1000.0;
        return tempC;
      }
    } else {
      console.error('Fehler beim Lesen der Temperaturdaten.');
    }
  } catch (error) {
    console.error(`Fehler beim Verarbeiten der Daten: ${error}`);
  }
  return null;
};

// Hauptfunktion zum Auslesen der Sensoren von beiden Bussen
const readAllTemps = async () => {
  try {
    for (const baseDir of baseDirs) {
      const sensorFolders = (await fs.readdir(baseDir)).filter(folder => folder.startsWith('28-'));

      for (const sensorFolder of sensorFolders) {
        const deviceFolder = path.join(baseDir, sensorFolder);
        const tempC = await readTemp(deviceFolder);
        if (tempC !== null) {
          console.log(`Sensor ${sensorFolder} - Temperatur: ${tempC.toFixed(3)}°C`);
        }
      }
    }
  } catch (error) {
    console.error(`Fehler beim Auslesen der Temperaturen: ${error}`);
  }
};

// Temperatur in regelmäßigen Abständen auslesen
setInterval(readAllTemps, 1000); // Alle 1 Sekunde auslesen
