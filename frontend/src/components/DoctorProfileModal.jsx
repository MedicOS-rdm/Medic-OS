import { useEffect, useState } from "react";
import { api } from "../api.js";

const MAX_LOGO_MB = 2;

export default function DoctorProfileModal({ onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState(null);

  useEffect(() => {
    api.doctorProfile.get().then(setForm);
  }, []);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await api.doctorProfile.update(form);
      onSaved({ ...updated, logo_base64: form.logo_base64 });
    } finally {
      setSaving(false);
    }
  }

  function handleLogoFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite volver a elegir el mismo archivo después
    if (!file) return;
    setLogoError(null);

    if (file.size > MAX_LOGO_MB * 1024 * 1024) {
      setLogoError(`La imagen debe pesar menos de ${MAX_LOGO_MB} MB.`);
      return;
    }
    if (!["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(file.type)) {
      setLogoError("Solo se aceptan imágenes PNG, JPG o WEBP.");
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      setLogoUploading(true);
      try {
        const result = await api.doctorProfile.uploadLogo(reader.result);
        setForm((f) => ({ ...f, logo_base64: result.logo_base64 }));
      } catch (err) {
        setLogoError(err.message);
      } finally {
        setLogoUploading(false);
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleRemoveLogo() {
    if (!confirm("¿Quitar el logo del consultorio? Volverá a mostrarse el logo genérico de MedicOs.")) return;
    setLogoUploading(true);
    try {
      await api.doctorProfile.removeLogo();
      setForm((f) => ({ ...f, logo_base64: null }));
    } finally {
      setLogoUploading(false);
    }
  }

  if (!form) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tab" style={{ background: "#0460D3" }} />
        <h2 className="modal-title">Perfil del médico</h2>
        <p className="hint" style={{ marginTop: -8, marginBottom: 14 }}>
          Estos datos aparecen en el encabezado de cada receta y certificado médico que generes.
        </p>

        <div className="logo-uploader">
          <div className="logo-preview">
            {form.logo_base64 ? (
              <img src={form.logo_base64} alt="Logo del consultorio" />
            ) : (
              <img src="/assets/logo.png" alt="Logo genérico de MedicOs" style={{ opacity: 0.5 }} />
            )}
          </div>
          <div>
            <p className="hint" style={{ margin: "0 0 8px" }}>
              Logo del consultorio {!form.logo_base64 && "(usando el logo genérico de MedicOs)"}
            </p>
            <label className="btn-ghost sm" style={{ display: "inline-block", cursor: "pointer" }}>
              {logoUploading ? "Subiendo…" : form.logo_base64 ? "Cambiar logo" : "Subir logo"}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleLogoFile}
                disabled={logoUploading}
                style={{ display: "none" }}
              />
            </label>
            {form.logo_base64 && (
              <button type="button" className="link-btn" onClick={handleRemoveLogo} disabled={logoUploading} style={{ marginLeft: 10 }}>
                Quitar
              </button>
            )}
            {logoError && <p className="form-error" style={{ marginTop: 6 }}>{logoError}</p>}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="form-grid" style={{ marginTop: 18 }}>
          <label className="span-2">
            Nombre completo
            <input value={form.full_name} disabled title="Solo el administrador de la plataforma puede corregir este nombre" />
            <span className="hint" style={{ marginTop: 2 }}>
              Este nombre lo asigna el administrador de MedicOs al crear tu cuenta. Si tiene un error, pídele que lo corrija —
              tú no puedes editarlo directamente.
            </span>
          </label>
          <label>
            C.I. (cédula personal)
            <input value={form.personal_id} onChange={set("personal_id")} />
          </label>
          <label>
            Cédula profesional / Reg. SENESCYT
            <input value={form.professional_license} onChange={set("professional_license")} />
          </label>
          <label>
            Especialidad
            <input value={form.specialty} onChange={set("specialty")} placeholder="Medicina General" />
          </label>
          <label>
            Correo electrónico
            <input type="email" value={form.email} onChange={set("email")} />
          </label>
          <label className="span-2">
            Nombre del consultorio
            <input value={form.clinic_name} onChange={set("clinic_name")} />
          </label>
          <label className="span-2">
            Dirección
            <input value={form.clinic_address} onChange={set("clinic_address")} />
          </label>
          <label>
            Teléfono
            <input value={form.clinic_phone} onChange={set("clinic_phone")} />
          </label>
          <label>
            Ciudad (lugar de emisión)
            <input value={form.city} onChange={set("city")} placeholder="Manta" />
          </label>

          <div className="modal-actions span-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? "Guardando…" : "Guardar perfil"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
