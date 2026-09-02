import { useEffect, useState, useCallback } from "react";
import { api, setUnauthorizedHandler } from "./api.js";
import AgendaView from "./components/AgendaView.jsx";
import PatientModal from "./components/PatientModal.jsx";
import AppointmentModal from "./components/AppointmentModal.jsx";
import PatientRecord from "./components/PatientRecord.jsx";
import DoctorProfileModal from "./components/DoctorProfileModal.jsx";
import LoginScreen from "./components/LoginScreen.jsx";
import UsersModal from "./components/UsersModal.jsx";
import ChangePasswordModal from "./components/ChangePasswordModal.jsx";
import ReminderSettingsModal from "./components/ReminderSettingsModal.jsx";
import NotificationSettingsModal from "./components/NotificationSettingsModal.jsx";
import IntakeVitalsModal from "./components/IntakeVitalsModal.jsx";
import BookingSettingsModal from "./components/BookingSettingsModal.jsx";
import Footer from "./components/Footer.jsx";
import { localISODate } from "./utils/date.js";

const ROLE_LABELS = { medico: "Médico", secretaria: "Secretaria", enfermera: "Enfermera" };

function todayISO() {
  return localISODate();
}

function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return localISODate(d);
}

function formatHeaderDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  const s = d.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function App() {
  // ---------- Sesión ----------
  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState(null);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    (async () => {
      try {
        // La sesión vive en una cookie httpOnly (A-01/A-02): JavaScript no
        // puede leerla para saber de antemano si existe, así que siempre
        // se intenta /auth/me; si no hay cookie válida, el backend
        // responde 401 y simplemente se muestra el login.
        const { user: me } = await api.auth.me();
        setUser(me);
      } catch {
        setUser(null);
      } finally {
        setAuthLoading(false);
      }
    })();
  }, []);

  function handleLogout() {
    api.auth.logout().catch(() => {});
    setUser(null);
  }

  const isMedico = user?.role === "medico";
  // Nuevo rol "enfermera": agenda igual que secretaria, y además puede
  // registrar signos vitales y editar alergias/antecedentes del paciente
  // — pero no accede a la nota clínica, recetas ni certificados (eso
  // sigue siendo exclusivo del médico).
  const isEnfermera = user?.role === "enfermera";

  // ---------- Datos de la app ----------
  const [date, setDate] = useState(todayISO());
  const [patients, setPatients] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showPatientModal, setShowPatientModal] = useState(false);
  const [showApptModal, setShowApptModal] = useState(false);
  const [search, setSearch] = useState("");
  const [record, setRecord] = useState(null); // { patientId, appointmentId } | null
  const [showDoctorProfile, setShowDoctorProfile] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showReminders, setShowReminders] = useState(false);
  const [showNotificationSettings, setShowNotificationSettings] = useState(false);
  const [showBookingSettings, setShowBookingSettings] = useState(false);
  const [editingPatient, setEditingPatient] = useState(null); // paciente que edita la enfermera (alergias/antecedentes)
  const [intakeAppt, setIntakeAppt] = useState(null); // cita para la que se registran signos vitales
  const [clinicLogo, setClinicLogo] = useState(null);

  const loadClinicLogo = useCallback(async () => {
    try {
      const profile = await api.doctorProfile.get();
      setClinicLogo(profile.logo_base64 || null);
    } catch {
      setClinicLogo(null);
    }
  }, []);

  const loadPatients = useCallback(async () => {
    setPatients(await api.patients.list());
  }, []);

  const loadAppointments = useCallback(async (d) => {
    setLoading(true);
    try {
      setAppointments(await api.appointments.listByDate(d));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    loadPatients();
  }, [user, loadPatients]);

  useEffect(() => {
    if (!user) return;
    loadClinicLogo();
  }, [user, loadClinicLogo]);

  useEffect(() => {
    if (!user) return;
    loadAppointments(date);
  }, [user, date, loadAppointments]);

  async function handleStatusChange(id, status) {
    setAppointments((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));
    try {
      await api.appointments.setStatus(id, status);
    } catch {
      loadAppointments(date);
    }
  }

  async function handleSendReminder(id) {
    await api.reminders.send(id);
    loadAppointments(date);
  }

  const filteredPatients = search
    ? patients.filter((p) => `${p.first_name} ${p.last_name}`.toLowerCase().includes(search.toLowerCase()))
    : patients;

  if (authLoading) {
    return (
      <div className="app-loading">
        <img src="/assets/logo.png" alt="MedicOs" className="brand-mark" />
      </div>
    );
  }

  if (!user) {
    return (
      <LoginScreen
        onAuthenticated={(u) => {
          setUser(u);
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-clinic">
            <img src={clinicLogo || "/assets/logo.png"} alt={user.clinic_name || "Consultorio"} className="brand-mark" />
            <div className="brand-clinic-name">{user.clinic_name || "Consultorio"}</div>
          </div>
          <div className="brand-app">
            <img src="/assets/logo.png" alt="MedicOs" className="brand-mark brand-mark-sm" />
            <div>
              <div className="brand-name"><span className="brand-medic">Medic</span><span className="brand-os">Os</span></div>
              <div className="brand-app-caption">Producto de RonnDuCorp.</div>
            </div>
          </div>
        </div>

        <button className="btn-primary full" onClick={() => setShowPatientModal(true)}>
          + Nuevo paciente
        </button>

        <input
          className="search-input"
          placeholder="Buscar paciente…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <ul className="patient-list">
          {filteredPatients.map((p) => (
            <li
              key={p.id}
              className={isMedico || isEnfermera ? "clickable" : ""}
              onClick={() => {
                if (isMedico) setRecord({ patientId: p.id, appointmentId: null });
                else if (isEnfermera) setEditingPatient(p);
              }}
            >
              <span>
                {p.first_name} {p.last_name}
              </span>
              {p.allergies && <span className="allergy-dot" title={`Alergia: ${p.allergies}`} />}
            </li>
          ))}
          {filteredPatients.length === 0 && <li className="hint">Sin resultados.</li>}
        </ul>

        <div className="sidebar-footer">
          {isMedico && (
            <>
              <button className="btn-ghost full" onClick={() => setShowDoctorProfile(true)}>
                Perfil del médico
              </button>
              <button className="btn-ghost full" onClick={() => setShowUsers(true)}>
                Gestionar usuarios
              </button>
              <button className="btn-ghost full" onClick={() => setShowBookingSettings(true)}>
                Reserva en línea
              </button>
              <button className="btn-ghost full" onClick={() => setShowReminders(true)}>
                Recordatorios
              </button>
              <button className="btn-ghost full" onClick={() => setShowNotificationSettings(true)}>
                Envío automático
              </button>
            </>
          )}
          <div className="user-badge">
            <div>
              <strong>{user.full_name}</strong>
              <span className="user-role-tag">{ROLE_LABELS[user.role] || user.role}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
              <button className="link-btn" onClick={() => setShowChangePassword(true)}>
                Cambiar contraseña
              </button>
              <button className="link-btn" onClick={handleLogout}>
                Cerrar sesión
              </button>
            </div>
          </div>
        </div>
      </aside>

      <main className={`main${record && isMedico ? " main--record" : ""}`}>
        {record && isMedico ? (
          <PatientRecord
            patientId={record.patientId}
            appointmentId={record.appointmentId}
            onOpenDoctorProfile={() => setShowDoctorProfile(true)}
            onBack={() => {
              setRecord(null);
              loadAppointments(date);
            }}
          />
        ) : (
          <>
            <header className="agenda-header">
              <div className="date-nav">
                <button className="btn-ghost icon" onClick={() => setDate((d) => shiftDate(d, -1))}>
                  ‹
                </button>
                <div className="date-label">
                  <div className="date-title">{formatHeaderDate(date)}</div>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </div>
                <button className="btn-ghost icon" onClick={() => setDate((d) => shiftDate(d, 1))}>
                  ›
                </button>
                <button className="btn-ghost" onClick={() => setDate(todayISO())}>
                  Hoy
                </button>
              </div>
              <button className="btn-primary" onClick={() => setShowApptModal(true)}>
                + Nueva cita
              </button>
            </header>

            <AgendaView
              appointments={appointments}
              loading={loading}
              isMedico={isMedico}
              canRecordVitals={isMedico || isEnfermera}
              onChangeStatus={handleStatusChange}
              onOpenRecord={(patientId, appointmentId) => isMedico && setRecord({ patientId, appointmentId })}
              onOpenVitals={(appt) => setIntakeAppt(appt)}
              onSendReminder={handleSendReminder}
            />
          </>
        )}
      </main>

      {showPatientModal && (
        <PatientModal
          isMedico={isMedico}
          canEditClinical={isMedico || isEnfermera}
          onClose={() => setShowPatientModal(false)}
          onCreated={() => {
            setShowPatientModal(false);
            loadPatients();
          }}
        />
      )}

      {showApptModal && (
        <AppointmentModal
          date={date}
          patients={patients}
          onClose={() => setShowApptModal(false)}
          onNewPatient={() => {
            setShowApptModal(false);
            setShowPatientModal(true);
          }}
          onCreated={() => {
            setShowApptModal(false);
            loadAppointments(date);
          }}
        />
      )}

      {showDoctorProfile && isMedico && (
        <DoctorProfileModal
          onClose={() => setShowDoctorProfile(false)}
          onSaved={() => {
            setShowDoctorProfile(false);
            loadClinicLogo();
          }}
        />
      )}

      {showUsers && isMedico && <UsersModal onClose={() => setShowUsers(false)} />}

      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}

      {showReminders && isMedico && <ReminderSettingsModal onClose={() => setShowReminders(false)} />}

      {showNotificationSettings && isMedico && (
        <NotificationSettingsModal onClose={() => setShowNotificationSettings(false)} />
      )}

      {showBookingSettings && isMedico && <BookingSettingsModal onClose={() => setShowBookingSettings(false)} />}

      {/* Nuevo rol "enfermera": edita alergias/antecedentes de un paciente
          existente sin acceder al resto del expediente clínico. */}
      {editingPatient && (
        <PatientModal
          patient={editingPatient}
          canEditClinical={isEnfermera}
          onClose={() => setEditingPatient(null)}
          onUpdated={() => {
            setEditingPatient(null);
            loadPatients();
          }}
        />
      )}

      {/* Nuevo rol "enfermera": signos vitales de ingreso ligados a la cita. */}
      {intakeAppt && (
        <IntakeVitalsModal
          appointment={intakeAppt}
          onClose={() => setIntakeAppt(null)}
          onSaved={() => {
            setIntakeAppt(null);
            loadAppointments(date);
          }}
        />
      )}

      <Footer />
    </div>
  );
}
