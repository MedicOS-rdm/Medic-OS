// Corrección funcional: "si los signos vitales están alterados se
// presentarán de rojo para marcar la alerta". Misma lógica que
// backend/src/validators.js -> vitalsAlerts, duplicada aquí a propósito
// para poder resaltar en rojo MIENTRAS la enfermera/el médico escribe,
// sin esperar una ida y vuelta al servidor. Son umbrales generales de
// adulto — una alerta visual de apoyo, nunca un diagnóstico.
export function vitalsAlerts({ blood_pressure, heart_rate, temperature_c } = {}) {
  const alerts = {};
  if (heart_rate !== undefined && heart_rate !== null && heart_rate !== "") {
    const hr = Number(heart_rate);
    if (!Number.isNaN(hr) && (hr < 60 || hr > 100)) {
      alerts.heart_rate = hr < 60 ? "Frecuencia cardiaca baja (bradicardia)" : "Frecuencia cardiaca alta (taquicardia)";
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
