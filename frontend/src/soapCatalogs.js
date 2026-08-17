// Catálogos de referencia para la historia clínica (SOAP completo).
// Son listas fijas (no vienen de la base de datos) — igual que las
// opciones de signos vitales que ya existían en PatientRecord.jsx.

// ---------- O · Examen físico ----------
// Cada línea de la plantilla que pediste, con un <select> de opciones
// comunes (la primera opción de cada una es el hallazgo "normal", igual
// que en tu plantilla de referencia).
export const PHYSICAL_EXAM_TEMPLATE = [
  {
    key: "consciente_orientado",
    label: "Consciente / orientado",
    options: [
      "Consciente, orientado en tiempo/espacio/persona",
      "Consciente, orientado parcialmente",
      "Somnoliento",
      "Estuporoso",
      "Inconsciente",
    ],
  },
  {
    key: "febril",
    label: "Temperatura",
    options: ["Afebril", "Febril", "Hipotermia"],
  },
  {
    key: "glasgow",
    label: "Glasgow",
    options: ["15/15", "14/15", "13/15", "12/15", "11/15", "10/15", "9/15", "≤8/15"],
  },
  {
    key: "cabeza",
    label: "Cabeza",
    options: ["Normocéfalo", "Con lesiones visibles", "Con deformidad", "Traumatismo evidente"],
  },
  {
    key: "torax",
    label: "Tórax",
    options: ["Simétrico", "Asimétrico", "Con lesiones visibles"],
  },
  {
    key: "rscs",
    label: "RsCs (ruidos cardíacos)",
    options: ["Rítmicos, sin soplos", "Arrítmicos", "Con soplo", "Taquicárdicos", "Bradicárdicos"],
  },
  {
    key: "csps",
    label: "CsPs (campos pulmonares)",
    options: ["Ventilados, sin ruidos agregados", "Con crépitos", "Con sibilancias", "Hipoventilados", "Estertores"],
  },
  {
    key: "abdomen",
    label: "Abdomen",
    options: [
      "Blando, depresible, no doloroso a la palpación",
      "Doloroso a la palpación",
      "Distendido",
      "Con defensa muscular",
      "Con masa palpable",
    ],
  },
  {
    key: "puno_percusion",
    label: "Puño percusión",
    options: ["Negativo bilateral", "Positivo derecho", "Positivo izquierdo", "Positivo bilateral"],
  },
  {
    key: "rshs",
    label: "RsHs (ruidos hidroaéreos)",
    options: ["Presentes, normoactivos", "Aumentados", "Disminuidos", "Ausentes"],
  },
  {
    key: "extremidades",
    label: "Extremidades",
    options: ["Sin edema, sin fóvea (S/F)", "Edema leve (+)", "Edema moderado (++)", "Edema severo (+++)", "Lesiones visibles"],
  },
];

export function defaultPhysicalExam() {
  const obj = {};
  PHYSICAL_EXAM_TEMPLATE.forEach((row) => {
    obj[row.key] = row.options[0];
  });
  return obj;
}

// Texto plano tipo "AL EF ... " a partir de las selecciones, para mostrar
// en el historial sin tener que reconstruir la grilla completa.
export function physicalExamToText(exam) {
  if (!exam) return "";
  const labels = {
    consciente_orientado: "",
    febril: "",
    glasgow: "Glasgow",
    cabeza: "Cabeza",
    torax: "Tórax",
    rscs: "RsCs",
    csps: "CsPs",
    abdomen: "Abdomen",
    puno_percusion: "Puño percusión",
    rshs: "RsHs",
    extremidades: "Ext",
  };
  return PHYSICAL_EXAM_TEMPLATE.map((row) => {
    const value = exam[row.key];
    if (!value) return null;
    const prefix = labels[row.key];
    return prefix ? `${prefix}: ${value}` : value;
  })
    .filter(Boolean)
    .join(" · ");
}

// ---------- P · Estudios ----------
export const LAB_STUDIES = [
  "Biometría hemática",
  "Química sanguínea",
  "Glucosa en ayunas",
  "Hemoglobina glicosilada (HbA1c)",
  "Perfil lipídico",
  "Pruebas de función hepática (TGO/TGP)",
  "Pruebas de función renal (BUN/Creatinina)",
  "Electrolitos séricos",
  "Examen microscópico de orina (EMO)",
  "Urocultivo",
  "Coproparasitario",
  "Proteína C reactiva (PCR)",
  "Velocidad de sedimentación (VSG)",
  "Tiempos de coagulación (TP/TTP)",
  "Perfil tiroideo (TSH/T4)",
  "Prueba de embarazo (BHCG)",
  "VIH",
  "VDRL/RPR",
  "Hemocultivo",
  "PSA",
  "Grupo sanguíneo y factor Rh",
];

export const IMAGING_STUDIES = [
  "Radiografía de tórax",
  "Radiografía simple de abdomen",
  "Radiografía de columna",
  "Radiografía de extremidades",
  "Ecografía abdominal",
  "Ecografía pélvica",
  "Ecografía obstétrica",
  "Ecografía renal y de vías urinarias",
  "Ecografía de partes blandas",
  "Tomografía de cráneo",
  "Tomografía de abdomen y pelvis",
  "Resonancia magnética",
  "Electrocardiograma (ECG)",
  "Ecocardiograma",
  "Mamografía",
  "Densitometría ósea",
];

// ---------- P · Tratamiento farmacológico ----------
export const DOSE_FREQUENCY_OPTIONS = [
  "Cada 4 horas",
  "Cada 6 horas",
  "Cada 8 horas",
  "Cada 12 horas",
  "Cada 24 horas",
  "Una vez al día",
  "Dos veces al día",
  "Tres veces al día",
  "Cuatro veces al día",
  "Según necesidad (PRN)",
  "Dosis única",
];

export const TREATMENT_DURATION_OPTIONS = [
  "1 día",
  "3 días",
  "5 días",
  "7 días",
  "10 días",
  "14 días",
  "21 días",
  "1 mes",
  "Uso continuo / indefinido",
  "Hasta terminar el frasco",
];

// ---------- P · Seguimiento ----------
// value: se usa para calcular la fecha de control sumando días a partir
// de hoy; label: lo que ve el médico en el <select>.
export const FOLLOW_UP_OPTIONS = [
  { value: "", label: "Sin control programado", days: null },
  { value: "3_dias", label: "En 3 días", days: 3 },
  { value: "1_semana", label: "En 1 semana", days: 7 },
  { value: "2_semanas", label: "En 2 semanas", days: 14 },
  { value: "1_mes", label: "En 1 mes", days: 30 },
  { value: "2_meses", label: "En 2 meses", days: 60 },
  { value: "3_meses", label: "En 3 meses", days: 90 },
  { value: "6_meses", label: "En 6 meses", days: 180 },
  { value: "1_ano", label: "En 1 año", days: 365 },
  { value: "si_persiste", label: "Solo si persisten los síntomas", days: null },
];

export function computeFollowUpDate(intervalValue, fromDate = new Date()) {
  const option = FOLLOW_UP_OPTIONS.find((o) => o.value === intervalValue);
  if (!option || !option.days) return null;
  const d = new Date(fromDate);
  d.setDate(d.getDate() + option.days);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
