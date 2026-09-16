// Corrección funcional: "si los signos vitales están alterados se
// presentarán de rojo para marcar la alerta". Misma lógica que
// backend/src/validators.js -> vitalsAlerts, duplicada aquí a propósito
// para poder resaltar en rojo MIENTRAS la enfermera/el médico escribe,
// sin esperar una ida y vuelta al servidor. Son umbrales generales de
// adulto — una alerta visual de apoyo, nunca un diagnóstico.

// Corrección solicitada por el usuario: los signos vitales (FC,
// temperatura, frecuencia respiratoria, SaO2) y la antropometría (peso,
// talla) se ingresan con un <select> ubicado por defecto en el valor
// normal, en vez de un campo numérico vacío — tanto al ingresar los
// datos (enfermera/médico) como en la nota de evolución. Compartido
// entre IntakeVitalsModal y PatientRecord para no duplicar la lista de
// opciones. Si el valor actual (de una nota vieja) no cae exactamente en
// la lista generada, se agrega igual para no perder ese dato al editar.
export function numericOptions(min, max, step, currentValue) {
  const opts = [];
  for (let v = min; v <= max + 1e-9; v += step) {
    opts.push(Math.round(v * 100) / 100);
  }
  const cur = currentValue !== "" && currentValue !== null && currentValue !== undefined ? Number(currentValue) : null;
  if (cur !== null && !Number.isNaN(cur) && !opts.some((o) => Math.abs(o - cur) < 1e-6)) {
    opts.push(cur);
    opts.sort((a, b) => a - b);
  }
  return opts;
}

// Valores normales por defecto para cada signo vital / medida, usados
// tanto en el registro de ingreso como en la nota de evolución.
export const VITAL_DEFAULTS = {
  blood_pressure: "120/80",
  heart_rate: "80",
  temperature_c: "36.5",
  respiratory_rate: "16",
  oxygen_saturation: "98",
  weight_kg: "70",
  height_cm: "165",
};

export function vitalsAlerts({ blood_pressure, heart_rate, temperature_c, respiratory_rate, oxygen_saturation } = {}) {
  const alerts = {};
  if (heart_rate !== undefined && heart_rate !== null && heart_rate !== "") {
    const hr = Number(heart_rate);
    if (!Number.isNaN(hr) && (hr < 60 || hr > 100)) {
      alerts.heart_rate = hr < 60 ? "Frecuencia cardiaca baja (bradicardia)" : "Frecuencia cardiaca alta (taquicardia)";
    }
  }
  if (respiratory_rate !== undefined && respiratory_rate !== null && respiratory_rate !== "") {
    const rr = Number(respiratory_rate);
    if (!Number.isNaN(rr) && (rr < 12 || rr > 20)) {
      alerts.respiratory_rate = rr < 12 ? "Frecuencia respiratoria baja (bradipnea)" : "Frecuencia respiratoria alta (taquipnea)";
    }
  }
  // Corrección solicitada por el usuario: faltaba SaO2 (saturación de
  // oxígeno) entre los signos vitales.
  if (oxygen_saturation !== undefined && oxygen_saturation !== null && oxygen_saturation !== "") {
    const spo2 = Number(oxygen_saturation);
    if (!Number.isNaN(spo2) && spo2 < 95) {
      alerts.oxygen_saturation = "Saturación de oxígeno baja (hipoxemia)";
    }
  }
  if (temperature_c !== undefined && temperature_c !== null && temperature_c !== "") {
    const temp = Number(temperature_c);
    if (!Number.isNaN(temp) && (temp < 35.5 || temp > 37.5)) {
      alerts.temperature_c = temp > 37.5 ? "Temperatura elevada (fiebre)" : "Temperatura baja (hipotermia)";
    }
  }
  if (blood_pressure && /^\d{2,3}\/\d{2,3}$/.test(String(blood_pressure).trim())) {
    const [sys, dia] = String(blood_pressure).trim().split("/").map(Number);
    if (sys >= 140 || dia >= 90) alerts.blood_pressure = "Presión arterial elevada (hipertensión)";
    else if (sys < 90 || dia < 60) alerts.blood_pressure = "Presión arterial baja (hipotensión)";
  }
  return alerts;
}
