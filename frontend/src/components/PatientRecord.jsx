import { useEffect, useState } from "react";
import { api } from "../api.js";
import DiagnosisSearch from "./DiagnosisSearch.jsx";
import PrescriptionModal from "./PrescriptionModal.jsx";
import CertificateModal from "./CertificateModal.jsx";
import PatientModal from "./PatientModal.jsx";
import AdditionalDiagnosesList from "./AdditionalDiagnosesList.jsx";
import TreatmentMedsEditor from "./TreatmentMedsEditor.jsx";
import MultiSelectChips from "./MultiSelectChips.jsx";
import PhysicalExamGrid from "./PhysicalExamGrid.jsx";
import { formatAge } from "../utils/age.js";
import { localISODate } from "../utils/date.js";
import {
  LAB_STUDIES,
  IMAGING_STUDIES,
  FOLLOW_UP_QUICK_OPTIONS,
  defaultPhysicalExam,
  physicalExamToText,
  addDaysToDate,
  describeFollowUpInterval,
} from "../soapCatalogs.js";

const EMPTY_NOTE = {
  // S · Subjetivo
  chief_complaint: "",
  present_illness: "",
  relevant_history: "",
  subjective: "",
  // O · Objetivo
  blood_pressure: "120/80",
  heart_rate: "80",
  temperature_c: "36.5",
  weight_kg: "",
  height_cm: "",
  physical_exam: defaultPhysicalExam(),
  clinical_findings: "",
  // A · Análisis
  diagnosis_code: "",
  diagnosis_label: "",
  clinical_assessment: "",
  additional_diagnoses: [],
  // P · Plan
  treatment_meds: [],
  non_pharmacological_treatment: "",
  studies_lab: [],
  studies_imaging: [],
  patient_education: "",
  warning_signs: "",
  follow_up_interval: "",
  follow_up_date: "",
  plan: "",
};

function computeBmi(weight, height) {
  const w = Number(weight);
  const h = Number(height);
  if (!w || !h) return null;
  const m = h / 100;
  return Math.round((w / (m * m)) * 10) / 10;
}

// Genera las opciones numéricas de un <select> de signos vitales. Si el
// valor actual (por ejemplo de una nota vieja) no cae exactamente en la
// lista generada, lo agregamos igual para no perder ese dato al editar.
function numericOptions(min, max, step, currentValue) {
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

function formatDateTime(iso) {
  return new Date(iso.replace(" ", "T")).toLocaleString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateKey(iso) {
  return iso.slice(0, 10); // "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DD"
}

function formatDayHeading(key) {
  return new Date(`${key}T00:00:00`).toLocaleDateString("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// Agrupa nota(s) de evolución, recetas y certificados que comparten la
// MISMA FECHA en un solo contenedor — sin importar la hora exacta ni si
// quedaron técnicamente ligados por consultation_id. Solo la fecha más
// reciente de todas se resalta.
function buildVisitGroups(history, prescriptions, certificates) {
  const allDateKeys = Array.from(
    new Set([
      ...history.map((c) => dateKey(c.created_at)),
      ...prescriptions.map((rx) => dateKey(rx.created_at)),
      ...certificates.map((cert) => dateKey(cert.created_at)),
    ])
  ).sort((a, b) => (a < b ? 1 : -1)); // más reciente primero

  return allDateKeys.map((key, index) => ({
    key,
    dateKey: key,
    isLatest: index === 0,
    notes: history.filter((c) => dateKey(c.created_at) === key),
    rx: prescriptions.filter((rx) => dateKey(rx.created_at) === key),
    certs: certificates.filter((cert) => dateKey(cert.created_at) === key),
  }));
}

const CERT_TYPE_LABELS = {
  enfermedad: "Enfermedad",
  aislamiento: "Aislamiento",
  teletrabajo: "Teletrabajo",
};

export default function PatientRecord({ patientId, appointmentId, onOpenDoctorProfile, onBack }) {
  const [patient, setPatient] = useState(null);
  const [history, setHistory] = useState([]);
  const [prescriptions, setPrescriptions] = useState([]);
  const [certificates, setCertificates] = useState([]);
  const [doctorReady, setDoctorReady] = useState(true);
  const [showRxModal, setShowRxModal] = useState(false);
  const [showCertModal, setShowCertModal] = useState(false);
  const [editingRx, setEditingRx] = useState(null);
  const [editingCert, setEditingCert] = useState(null);
  const [showEditPatient, setShowEditPatient] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState(EMPTY_NOTE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedMsg, setSavedMsg] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [p, h, rx, certs, profile] = await Promise.all([
        api.patients.get(patientId),
        api.consultations.listByPatient(patientId),
        api.prescriptions.listByPatient(patientId),
        api.certificates.listByPatient(patientId),
        api.doctorProfile.get(),
      ]);
      setPatient(p);
      setHistory(h);
      setPrescriptions(rx);
      setCertificates(certs);
      setDoctorReady(Boolean(profile.full_name));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    setNote(EMPTY_NOTE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  const set = (field) => (e) => setNote({ ...note, [field]: e.target.value });
  const bmi = computeBmi(note.weight_kg, note.height_cm);

  function startEditNote(c) {
    setEditingNoteId(c.id);
    setNote({
      chief_complaint: c.chief_complaint || "",
      present_illness: c.present_illness || "",
      relevant_history: c.relevant_history || "",
      subjective: c.subjective || "",
      blood_pressure: c.blood_pressure || "",
      heart_rate: c.heart_rate ?? "",
      temperature_c: c.temperature_c ?? "",
      weight_kg: c.weight_kg ?? "",
      height_cm: c.height_cm ?? "",
      physical_exam: c.physical_exam || defaultPhysicalExam(),
      clinical_findings: c.clinical_findings || "",
      diagnosis_code: c.diagnosis_code || "",
      diagnosis_label: c.diagnosis_label || "",
      clinical_assessment: c.clinical_assessment || "",
      additional_diagnoses: c.additional_diagnoses || [],
      treatment_meds: c.treatment_meds || [],
      non_pharmacological_treatment: c.non_pharmacological_treatment || "",
      studies_lab: c.studies_lab || [],
      studies_imaging: c.studies_imaging || [],
      patient_education: c.patient_education || "",
      warning_signs: c.warning_signs || "",
      follow_up_interval: c.follow_up_interval || "",
      follow_up_date: c.follow_up_date || "",
      plan: c.plan || "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEditNote() {
    setEditingNoteId(null);
    setNote(EMPTY_NOTE);
  }

  async function handleDeleteNote(id) {
    if (!confirm("¿Eliminar esta nota de evolución? Esta acción no se puede deshacer.")) return;
    await api.consultations.remove(id);
    if (editingNoteId === id) cancelEditNote();
    load();
  }

  async function handleDeleteRx(id) {
    if (!confirm("¿Eliminar esta receta? Esta acción no se puede deshacer.")) return;
    await api.prescriptions.remove(id);
    load();
  }

  async function handleDeleteCert(id) {
    if (!confirm("¿Eliminar este certificado médico? Esta acción no se puede deshacer.")) return;
    await api.certificates.remove(id);
    load();
  }

  const [sendingId, setSendingId] = useState(null); // `${kind}-${id}-${channel}` mientras se envía

  async function handleSendDocument(kind, id, channel) {
    setSendingId(`${kind}-${id}-${channel}`);
    try {
      const api_ = kind === "prescription" ? api.prescriptions : api.certificates;
      const result = await api_.send(id, channel);
      const outcome = result[channel];
      if (!outcome) {
        alert("No se pudo enviar: revisa la configuración en \"Envío automático\".");
      } else if (outcome.ok) {
        alert(channel === "whatsapp" ? "Enviado por WhatsApp." : "Enviado por correo.");
      } else {
        alert(`No se pudo enviar: ${outcome.error}`);
      }
    } catch (err) {
      alert(`No se pudo enviar: ${err.message}`);
    } finally {
      setSendingId(null);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const payload = {
      chief_complaint: note.chief_complaint || null,
      present_illness: note.present_illness || null,
      relevant_history: note.relevant_history || null,
      subjective: note.subjective || null,
      blood_pressure: note.blood_pressure || null,
      heart_rate: note.heart_rate ? Number(note.heart_rate) : null,
      temperature_c: note.temperature_c ? Number(note.temperature_c) : null,
      weight_kg: note.weight_kg ? Number(note.weight_kg) : null,
      height_cm: note.height_cm ? Number(note.height_cm) : null,
      physical_exam: note.physical_exam || null,
      clinical_findings: note.clinical_findings || null,
      diagnosis_code: note.diagnosis_code || null,
      diagnosis_label: note.diagnosis_label || null,
      clinical_assessment: note.clinical_assessment || null,
      additional_diagnoses: note.additional_diagnoses.filter((d) => d.label),
      treatment_meds: note.treatment_meds,
      non_pharmacological_treatment: note.non_pharmacological_treatment || null,
      studies_lab: note.studies_lab,
      studies_imaging: note.studies_imaging,
      patient_education: note.patient_education || null,
      warning_signs: note.warning_signs || null,
      follow_up_interval: note.follow_up_interval || null,
      follow_up_date: note.follow_up_date || null,
      plan: note.plan || null,
    };
    try {
      let generatedRxId = null;
      if (editingNoteId) {
        await api.consultations.update(editingNoteId, payload);
        setEditingNoteId(null);
      } else {
        const created = await api.consultations.create({
          patient_id: patientId,
          appointment_id: appointmentId ?? null,
          ...payload,
        });
        generatedRxId = created.generated_prescription_id;
      }
      setNote(EMPTY_NOTE);
      setSavedMsg(
        generatedRxId ? "✓ Nota guardada — se generó la receta automáticamente con los medicamentos del tratamiento." : true
      );
      setTimeout(() => setSavedMsg(false), generatedRxId ? 5000 : 2500);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading || !patient) {
    return <p className="empty-state">Cargando expediente…</p>;
  }

  const visits = buildVisitGroups(history, prescriptions, certificates);

  // Si el médico acaba de escribir una nota HOY, las recetas/certificados
  // que cree con los botones de abajo se vinculan automáticamente a esa
  // nota (para que queden agrupados). Si no hay nota de hoy, quedan
  // sueltos bajo la fecha de hoy — sin engancharse a una visita vieja.
  const todayKey = localISODate();
  const todaysConsultation = history.find((c) => dateKey(c.created_at) === todayKey);
  const defaultConsultationId = todaysConsultation ? todaysConsultation.id : null;
  // Prioriza el diagnóstico que el médico tiene escrito AHORA MISMO en el
  // formulario de la nota (aunque todavía no la haya guardado) — así, si
  // llena el diagnóstico y de una vez pulsa "+ Nuevo certificado" sin
  // guardar antes, igual se precarga. Si el formulario está vacío, cae de
  // respaldo al diagnóstico de la nota que ya se guardó hoy (si existe).
  const defaultDiagnosis = note.diagnosis_label
    ? { code: note.diagnosis_code, label: note.diagnosis_label }
    : todaysConsultation?.diagnosis_label
    ? { code: todaysConsultation.diagnosis_code, label: todaysConsultation.diagnosis_label }
    : null;

  return (
    <div className="record-shell">
      <button className="btn-ghost back-btn" onClick={onBack}>
        ← Volver a la agenda
      </button>

      <div className="record-grid">
        {/* ---------- Columna izquierda: ficha + historial ---------- */}
        <aside className="record-history">
          <div className="folder-card">
            <div className="modal-tab" style={{ background: "#0460D3" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <h2 className="patient-title">
                {patient.first_name} {patient.last_name}
              </h2>
              <button type="button" className="link-btn" onClick={() => setShowEditPatient(true)}>
                Editar
              </button>
            </div>
            {formatAge(patient.birth_date) && (
              <div className="hint" style={{ marginTop: -6, marginBottom: 6 }}>
                {formatAge(patient.birth_date)}
              </div>
            )}
            {patient.clinical_history_number && (
              <div className="hint" style={{ marginTop: -6, marginBottom: 6 }}>
                HC #{patient.clinical_history_number}
              </div>
            )}
            <dl className="id-list">
              {patient.birth_date && (
                <>
                  <dt>Nacimiento</dt>
                  <dd>
                    {patient.birth_date}
                    {formatAge(patient.birth_date) ? ` (${formatAge(patient.birth_date)})` : ""}
                  </dd>
                </>
              )}
              {patient.gender && (
                <>
                  <dt>Género</dt>
                  <dd>{patient.gender}</dd>
                </>
              )}
              {patient.blood_type && (
                <>
                  <dt>Tipo de sangre</dt>
                  <dd>{patient.blood_type}</dd>
                </>
              )}
              {patient.phone && (
                <>
                  <dt>Teléfono</dt>
                  <dd>{patient.phone}</dd>
                </>
              )}
              {patient.id_number && (
                <>
                  <dt>Cédula</dt>
                  <dd>{patient.id_number}</dd>
                </>
              )}
              {patient.workplace && (
                <>
                  <dt>Institución</dt>
                  <dd>{patient.workplace}</dd>
                </>
              )}
            </dl>

            {patient.allergies && (
              <div className="allergy-banner">⚠ ALERGIAS: {patient.allergies}</div>
            )}
            {patient.chronic_conditions && (
              <div className="chronic-note">
                <strong>Antecedentes:</strong> {patient.chronic_conditions}
              </div>
            )}
          </div>

          <div className="rx-section-header">
            <h3 className="history-title" style={{ margin: 0 }}>
              Historial de atenciones
            </h3>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-primary sm" onClick={() => setShowRxModal(true)}>
                + Nueva receta
              </button>
              <button className="btn-primary sm" onClick={() => setShowCertModal(true)}>
                + Nuevo certificado
              </button>
            </div>
          </div>

          {visits.length === 0 ? (
            <p className="hint">Aún no hay atenciones registradas para este paciente.</p>
          ) : (
            <ol className="visit-list">
              {visits.map((v) => (
                <li key={v.key} className={`visit-day${v.isLatest ? " visit-day--latest" : ""}`}>
                  <div className="visit-day-header">
                    <span>{formatDayHeading(v.dateKey)}</span>
                  </div>

                  {v.notes.map((c) => (
                    <div key={`note-${c.id}`} className="folder-card history-card visit-item">
                      <div className="modal-tab" style={{ background: v.isLatest ? "#6d28d9" : "#2B5C8A" }} />
                      <div className="history-date">{formatDateTime(c.created_at)} · Nota de evolución</div>
                      {c.diagnosis_label && (
                        <div className="history-dx">
                          {c.diagnosis_code && <span className="cie-code">{c.diagnosis_code}</span>}{" "}
                          {c.diagnosis_label}
                        </div>
                      )}
                      {c.additional_diagnoses?.length > 0 && (
                        <div className="history-field">
                          <strong>Dx adicionales:</strong>{" "}
                          {c.additional_diagnoses.map((d) => d.label).filter(Boolean).join(", ")}
                        </div>
                      )}
                      {c.chief_complaint && <div className="history-field"><strong>Motivo:</strong> {c.chief_complaint}</div>}
                      {c.present_illness && <div className="history-field"><strong>Enf. actual:</strong> {c.present_illness}</div>}
                      {c.subjective && <div className="history-field"><strong>S:</strong> {c.subjective}</div>}
                      {(c.blood_pressure || c.heart_rate || c.bmi) && (
                        <div className="history-field">
                          <strong>O:</strong>{" "}
                          {[
                            c.blood_pressure && `PA ${c.blood_pressure}`,
                            c.heart_rate && `FC ${c.heart_rate} lpm`,
                            c.temperature_c && `T ${c.temperature_c}°C`,
                            c.bmi && `IMC ${c.bmi}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      )}
                      {c.physical_exam && (
                        <div className="history-field"><strong>EF:</strong> {physicalExamToText(c.physical_exam)}</div>
                      )}
                      {(c.studies_lab?.length > 0 || c.studies_imaging?.length > 0) && (
                        <div className="history-field">
                          <strong>Estudios:</strong> {[...(c.studies_lab || []), ...(c.studies_imaging || [])].join(", ")}
                        </div>
                      )}
                      {c.follow_up_date && (
                        <div className="history-field"><strong>Control:</strong> {c.follow_up_date}</div>
                      )}
                      {c.plan && <div className="history-field"><strong>P:</strong> {c.plan}</div>}
                      <div className="visit-item-actions">
                        <button type="button" className="link-btn" onClick={() => startEditNote(c)}>
                          Editar
                        </button>
                        <button type="button" className="link-btn link-btn-danger" onClick={() => handleDeleteNote(c.id)}>
                          Eliminar
                        </button>
                      </div>
                    </div>
                  ))}

                  {v.rx.map((rx) => (
                    <div key={`rx-${rx.id}`} className="folder-card history-card visit-item">
                      <div className="modal-tab" style={{ background: v.isLatest ? "#6d28d9" : "#5B6B5F" }} />
                      <div className="history-date">{formatDateTime(rx.created_at)} · Receta</div>
                      <div className="history-field">{rx.items.map((it) => it.generic_name).join(", ")}</div>
                      <div className="visit-item-actions">
                        <a className="link-btn" href={api.prescriptions.pdfUrl(rx.id)} target="_blank" rel="noreferrer">
                          Ver PDF
                        </a>
                        <button type="button" className="link-btn" onClick={() => setEditingRx(rx)}>
                          Editar
                        </button>
                        <button type="button" className="link-btn link-btn-danger" onClick={() => handleDeleteRx(rx.id)}>
                          Eliminar
                        </button>
                      </div>
                      <div className="visit-item-actions">
                        <button
                          type="button"
                          className="link-btn"
                          disabled={sendingId === `prescription-${rx.id}-whatsapp`}
                          onClick={() => handleSendDocument("prescription", rx.id, "whatsapp")}
                        >
                          {sendingId === `prescription-${rx.id}-whatsapp` ? "Enviando…" : "Enviar por WhatsApp"}
                        </button>
                        <button
                          type="button"
                          className="link-btn"
                          disabled={sendingId === `prescription-${rx.id}-email`}
                          onClick={() => handleSendDocument("prescription", rx.id, "email")}
                        >
                          {sendingId === `prescription-${rx.id}-email` ? "Enviando…" : "Enviar por correo"}
                        </button>
                      </div>
                    </div>
                  ))}

                  {v.certs.map((cert) => (
                    <div key={`cert-${cert.id}`} className="folder-card history-card visit-item">
                      <div className="modal-tab" style={{ background: v.isLatest ? "#6d28d9" : "#2B5C8A" }} />
                      <div className="history-date">{formatDateTime(cert.created_at)} · Certificado médico</div>
                      <div className="history-dx">
                        {CERT_TYPE_LABELS[cert.certificate_type] || cert.certificate_type}
                        {cert.diagnosis_label ? ` — ${cert.diagnosis_label}` : ""}
                      </div>
                      <div className="history-field">
                        {cert.days_granted} día{cert.days_granted === 1 ? "" : "s"} · {cert.date_from} a {cert.date_to}
                      </div>
                      <div className="visit-item-actions">
                        <a className="link-btn" href={api.certificates.pdfUrl(cert.id)} target="_blank" rel="noreferrer">
                          Ver PDF
                        </a>
                        <button type="button" className="link-btn" onClick={() => setEditingCert(cert)}>
                          Editar
                        </button>
                        <button type="button" className="link-btn link-btn-danger" onClick={() => handleDeleteCert(cert.id)}>
                          Eliminar
                        </button>
                      </div>
                      <div className="visit-item-actions">
                        <button
                          type="button"
                          className="link-btn"
                          disabled={sendingId === `certificate-${cert.id}-whatsapp`}
                          onClick={() => handleSendDocument("certificate", cert.id, "whatsapp")}
                        >
                          {sendingId === `certificate-${cert.id}-whatsapp` ? "Enviando…" : "Enviar por WhatsApp"}
                        </button>
                        <button
                          type="button"
                          className="link-btn"
                          disabled={sendingId === `certificate-${cert.id}-email`}
                          onClick={() => handleSendDocument("certificate", cert.id, "email")}
                        >
                          {sendingId === `certificate-${cert.id}-email` ? "Enviando…" : "Enviar por correo"}
                        </button>
                      </div>
                    </div>
                  ))}
                </li>
              ))}
            </ol>
          )}
        </aside>

        {/* ---------- Columna derecha: nueva nota SOAP ---------- */}
        <section className="record-note folder-card">
          <div className="modal-tab" style={{ background: "#C08A3E" }} />
          <h3 className="modal-title">
            {editingNoteId ? "Editar nota de evolución (SOAP)" : "Nueva nota de evolución (SOAP)"}
          </h3>

          <form onSubmit={handleSave} className="soap-form">
            {/* ---------- S · Subjetivo ---------- */}
            <div className="soap-block">
              <span className="soap-letter">S · Subjetivo</span>
              <div className="soap-2col">
                <label>
                  Motivo de consulta
                  <input
                    value={note.chief_complaint}
                    onChange={set("chief_complaint")}
                    placeholder="Ej. Dolor abdominal de 2 días de evolución"
                  />
                </label>
                <label>
                  Antecedentes relevantes
                  <input
                    value={note.relevant_history}
                    onChange={set("relevant_history")}
                    placeholder="Patológicos, quirúrgicos, familiares, alérgicos…"
                  />
                </label>
                <label className="span-2">
                  Enfermedad actual
                  <textarea
                    rows={2}
                    value={note.present_illness}
                    onChange={set("present_illness")}
                    placeholder="Cómo y cuándo empezó, evolución, síntomas asociados…"
                  />
                </label>
                <label className="span-2">
                  Otros datos referidos por el paciente
                  <textarea
                    rows={2}
                    value={note.subjective}
                    onChange={set("subjective")}
                    placeholder="Cualquier otro dato subjetivo que quieras anotar…"
                  />
                </label>
              </div>
            </div>

            {/* ---------- O · Objetivo ---------- */}
            <div className="soap-block">
              <span className="soap-letter">O · Objetivo (signos vitales)</span>
              <div className="vitals-grid">
                <label>
                  Presión arterial
                  <input value={note.blood_pressure} onChange={set("blood_pressure")} placeholder="120/80" />
                </label>
                <label>
                  FC (lpm)
                  <select value={note.heart_rate} onChange={set("heart_rate")}>
                    <option value="">Seleccionar…</option>
                    {numericOptions(30, 220, 1, note.heart_rate).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Temp (°C)
                  <select value={note.temperature_c} onChange={set("temperature_c")}>
                    <option value="">Seleccionar…</option>
                    {numericOptions(34, 42, 0.1, note.temperature_c).map((v) => (
                      <option key={v} value={v}>
                        {v.toFixed(1)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Peso (kg)
                  <select value={note.weight_kg} onChange={set("weight_kg")}>
                    <option value="">Seleccionar…</option>
                    {numericOptions(1, 150, 0.5, note.weight_kg).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Talla (cm)
                  <select value={note.height_cm} onChange={set("height_cm")}>
                    <option value="">Seleccionar…</option>
                    {numericOptions(30, 220, 1, note.height_cm).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  IMC
                  <input value={bmi ?? "—"} disabled />
                </label>
              </div>

              <div style={{ marginTop: 14 }}>
                <span className="soap-sublabel">Examen físico</span>
                <PhysicalExamGrid exam={note.physical_exam} onChange={(exam) => setNote((n) => ({ ...n, physical_exam: exam }))} />
              </div>

              <label style={{ marginTop: 12, display: "block" }}>
                Hallazgos adicionales
                <textarea
                  rows={2}
                  value={note.clinical_findings}
                  onChange={set("clinical_findings")}
                  placeholder="Cualquier hallazgo que no esté cubierto arriba…"
                />
              </label>
            </div>

            {/* ---------- A · Análisis ---------- */}
            <div className="soap-block">
              <span className="soap-letter">A · Análisis</span>
              <label>
                Diagnóstico principal (CIE-10)
                <DiagnosisSearch
                  code={note.diagnosis_code}
                  label={note.diagnosis_label}
                  onSelect={({ code, label }) => setNote((n) => ({ ...n, diagnosis_code: code, diagnosis_label: label }))}
                />
              </label>

              <div style={{ marginTop: 12 }}>
                <span className="soap-sublabel">Diagnósticos adicionales</span>
                <AdditionalDiagnosesList
                  diagnoses={note.additional_diagnoses}
                  onChange={(list) => setNote((n) => ({ ...n, additional_diagnoses: list }))}
                />
              </div>

              <label style={{ marginTop: 12, display: "block" }}>
                Evaluación clínica
                <textarea
                  rows={2}
                  value={note.clinical_assessment}
                  onChange={set("clinical_assessment")}
                  placeholder="Impresión diagnóstica, razonamiento clínico…"
                />
              </label>
            </div>

            {/* ---------- P · Plan ---------- */}
            <div className="soap-block">
              <span className="soap-letter">P · Plan</span>

              <span className="soap-sublabel">Tratamiento farmacológico</span>
              <TreatmentMedsEditor
                items={note.treatment_meds}
                onChange={(items) => setNote((n) => ({ ...n, treatment_meds: items }))}
              />
              {note.treatment_meds.length > 0 && !editingNoteId && (
                <p className="hint" style={{ marginTop: 4 }}>
                  Al guardar la nota, se generará automáticamente una receta con estos medicamentos.
                </p>
              )}

              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
                <input
                  type="checkbox"
                  checked={Boolean(note.non_pharmacological_treatment)}
                  onChange={(e) => setNote((n) => ({ ...n, non_pharmacological_treatment: e.target.checked ? " " : "" }))}
                />
                Incluye tratamiento no farmacológico
              </label>
              {note.non_pharmacological_treatment !== "" && (
                <textarea
                  rows={2}
                  value={note.non_pharmacological_treatment.trim()}
                  onChange={set("non_pharmacological_treatment")}
                  placeholder="Reposo, hidratación, fisioterapia, dieta, curaciones…"
                  style={{ marginTop: 6 }}
                />
              )}

              <div className="soap-2col" style={{ marginTop: 14 }}>
                <div>
                  <span className="soap-sublabel">Estudios de laboratorio</span>
                  <MultiSelectChips
                    options={LAB_STUDIES}
                    values={note.studies_lab}
                    onChange={(v) => setNote((n) => ({ ...n, studies_lab: v }))}
                    placeholder="Seleccionar examen de laboratorio…"
                  />
                </div>
                <div>
                  <span className="soap-sublabel">Estudios de imagen</span>
                  <MultiSelectChips
                    options={IMAGING_STUDIES}
                    values={note.studies_imaging}
                    onChange={(v) => setNote((n) => ({ ...n, studies_imaging: v }))}
                    placeholder="Seleccionar estudio de imagen…"
                  />
                </div>
              </div>

              <div className="soap-2col" style={{ marginTop: 14 }}>
                <label>
                  Educación al paciente
                  <textarea
                    rows={2}
                    value={note.patient_education}
                    onChange={set("patient_education")}
                    placeholder="Qué le explicaste al paciente sobre su condición…"
                  />
                </label>
                <label>
                  Signos de alarma
                  <textarea
                    rows={2}
                    value={note.warning_signs}
                    onChange={set("warning_signs")}
                    placeholder="Por qué debería volver antes de la próxima cita…"
                  />
                </label>
              </div>

              <label style={{ marginTop: 12, display: "block", maxWidth: 360 }}>
                Seguimiento / control
                <input
                  type="date"
                  value={note.follow_up_date}
                  onChange={(e) => {
                    const date = e.target.value;
                    setNote((n) => ({
                      ...n,
                      follow_up_date: date,
                      follow_up_interval: describeFollowUpInterval(date),
                    }));
                  }}
                />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {FOLLOW_UP_QUICK_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className="btn-ghost sm"
                      onClick={() => {
                        const date = addDaysToDate(opt.days);
                        setNote((n) => ({
                          ...n,
                          follow_up_date: date,
                          follow_up_interval: describeFollowUpInterval(date),
                        }));
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                  {note.follow_up_date && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => setNote((n) => ({ ...n, follow_up_date: "", follow_up_interval: "" }))}
                    >
                      Quitar
                    </button>
                  )}
                </div>
                {note.follow_up_date && (
                  <span className="hint" style={{ display: "block", marginTop: 4 }}>
                    {note.follow_up_interval} · {note.follow_up_date}
                  </span>
                )}
              </label>

              <label style={{ marginTop: 12, display: "block" }}>
                Notas adicionales del plan
                <textarea
                  rows={2}
                  value={note.plan}
                  onChange={set("plan")}
                  placeholder="Cualquier otra indicación que no esté cubierta arriba…"
                />
              </label>
            </div>

            {error && <p className="form-error">{error}</p>}
            {savedMsg && <p className="saved-msg">{typeof savedMsg === "string" ? savedMsg : "✓ Nota guardada."}</p>}
            {editingNoteId && <p className="hint">Editando una nota existente.</p>}

            <div className="modal-actions">
              {editingNoteId && (
                <button type="button" className="btn-ghost" onClick={cancelEditNote}>
                  Cancelar edición
                </button>
              )}
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? "Guardando…" : editingNoteId ? "Actualizar nota" : "Guardar nota"}
              </button>
            </div>
          </form>
        </section>
      </div>

      {(showRxModal || editingRx) && (
        <PrescriptionModal
          patientId={patientId}
          consultationId={editingRx ? editingRx.consultation_id ?? null : defaultConsultationId}
          existing={editingRx}
          doctorReady={doctorReady}
          onOpenDoctorProfile={onOpenDoctorProfile}
          onClose={() => {
            setShowRxModal(false);
            setEditingRx(null);
            load();
          }}
        />
      )}

      {(showCertModal || editingCert) && (
        <CertificateModal
          patientId={patientId}
          consultationId={editingCert ? editingCert.consultation_id ?? null : defaultConsultationId}
          existing={editingCert}
          defaultDiagnosis={editingCert ? null : defaultDiagnosis}
          doctorReady={doctorReady}
          onOpenDoctorProfile={onOpenDoctorProfile}
          onClose={() => {
            setShowCertModal(false);
            setEditingCert(null);
            load();
          }}
        />
      )}

      {showEditPatient && (
        <PatientModal
          isMedico={true}
          patient={patient}
          onClose={() => setShowEditPatient(false)}
          onUpdated={() => {
            setShowEditPatient(false);
            load();
          }}
        />
      )}
    </div>
  );
}
