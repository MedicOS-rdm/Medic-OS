import { useEffect, useState } from "react";
import { api } from "../api.js";
import DiagnosisSearch from "./DiagnosisSearch.jsx";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetweenInclusive(fromISO, toISO) {
  if (!fromISO || !toISO) return null;
  const from = new Date(`${fromISO}T00:00:00`);
  const to = new Date(`${toISO}T00:00:00`);
  const diff = Math.round((to - from) / (1000 * 60 * 60 * 24));
  return diff >= 0 ? diff + 1 : null;
}

const TYPE_OPTIONS = [
  { value: "enfermedad", label: "Enfermedad" },
  { value: "aislamiento", label: "Aislamiento" },
  { value: "teletrabajo", label: "Teletrabajo" },
];

// existing: si se pasa un certificado ya emitido, el modal lo edita en vez
// de crear uno nuevo.
export default function CertificateModal({ patientId, consultationId, existing = null, doctorReady, onClose, onOpenDoctorProfile }) {
  const isEdit = Boolean(existing);
  const [diagnosisCode, setDiagnosisCode] = useState(existing?.diagnosis_code || "");
  const [diagnosisLabel, setDiagnosisLabel] = useState(existing?.diagnosis_label || "");
  const [clinicalPicture, setClinicalPicture] = useState(existing?.clinical_picture || "");
  const [presentsSymptoms, setPresentsSymptoms] = useState(existing ? Boolean(existing.presents_symptoms) : true);
  const [certificateType, setCertificateType] = useState(existing?.certificate_type || "enfermedad");
  const [description, setDescription] = useState(existing?.description || "");
  const [dateFrom, setDateFrom] = useState(existing?.date_from || todayISO());
  const [dateTo, setDateTo] = useState(existing?.date_to || todayISO());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [doneId, setDoneId] = useState(null);

  const autoDays = daysBetweenInclusive(dateFrom, dateTo);

  useEffect(() => {
    // Si "hasta" queda antes que "desde", lo empujamos para que el rango sea válido.
    if (dateTo < dateFrom) setDateTo(dateFrom);
  }, [dateFrom, dateTo]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!diagnosisLabel.trim()) {
      setError("Escribe o selecciona un diagnóstico.");
      return;
    }
    if (!autoDays || autoDays < 1) {
      setError("El rango de fechas no es válido.");
      return;
    }
    setSaving(true);
    const payload = {
      diagnosis_code: diagnosisCode || null,
      diagnosis_label: diagnosisLabel,
      clinical_picture: clinicalPicture || null,
      presents_symptoms: presentsSymptoms,
      certificate_type: certificateType,
      description: description || null,
      date_from: dateFrom,
      date_to: dateTo,
      days_granted: autoDays,
    };
    try {
      if (isEdit) {
        await api.certificates.update(existing.id, payload);
        setDoneId(existing.id);
      } else {
        const cert = await api.certificates.create({ patient_id: patientId, consultation_id: consultationId ?? null, ...payload });
        setDoneId(cert.id);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-card rx-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tab" style={{ background: "#2B5C8A" }} />
        <h2 className="modal-title">{isEdit ? "Editar certificado médico" : "Nuevo certificado médico"}</h2>

        {!doctorReady && (
          <p className="hint rx-warning">
            No has llenado el perfil del médico — el certificado se generará incompleto.{" "}
            <button type="button" className="link-btn" onClick={onOpenDoctorProfile}>
              Llenarlo ahora
            </button>
          </p>
        )}

        {doneId ? (
          <div className="rx-success">
            <p>✓ Certificado {isEdit ? "actualizado" : "generado"} correctamente.</p>
            <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
              <a className="btn-primary" href={api.certificates.pdfUrl(doneId)} target="_blank" rel="noreferrer">
                Ver / descargar PDF
              </a>
              <button className="btn-ghost" onClick={onClose}>
                Cerrar
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <label className="soap-block">
              <span className="soap-letter">Diagnóstico (CIE-10)</span>
              <DiagnosisSearch
                code={diagnosisCode}
                label={diagnosisLabel}
                onSelect={({ code, label }) => {
                  setDiagnosisCode(code);
                  setDiagnosisLabel(label);
                }}
              />
            </label>

            <label className="soap-block" style={{ marginTop: 12 }}>
              <span className="soap-letter">Cuadro clínico</span>
              <textarea
                rows={2}
                value={clinicalPicture}
                onChange={(e) => setClinicalPicture(e.target.value)}
                placeholder="Ej. Dolor abdominal tipo cólico, náuseas, vómito, deposiciones líquidas, alza térmica…"
              />
            </label>

            <div className="vitals-grid" style={{ marginTop: 12, gridTemplateColumns: "1fr 1fr" }}>
              <label>
                Presenta síntomas
                <select value={presentsSymptoms ? "si" : "no"} onChange={(e) => setPresentsSymptoms(e.target.value === "si")}>
                  <option value="si">Sí</option>
                  <option value="no">No</option>
                </select>
              </label>
              <label>
                Tipo
                <select value={certificateType} onChange={(e) => setCertificateType(e.target.value)}>
                  {TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="soap-block" style={{ marginTop: 12 }}>
              <span className="soap-letter">Descripción adicional (opcional)</span>
              <textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Ej. Cefalea, tos productiva mucopurulenta…"
              />
            </label>

            <div className="vitals-grid" style={{ marginTop: 12, gridTemplateColumns: "1fr 1fr 1fr" }}>
              <label>
                Desde
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
              </label>
              <label>
                Hasta
                <input type="date" value={dateTo} min={dateFrom} onChange={(e) => setDateTo(e.target.value)} />
              </label>
              <label>
                Días concedidos
                <input value={autoDays ?? "—"} disabled />
              </label>
            </div>

            {error && <p className="form-error" style={{ marginTop: 12 }}>{error}</p>}

            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={onClose}>
                Cancelar
              </button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? "Guardando…" : isEdit ? "Guardar cambios" : "Generar certificado"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
