const BASE = "/api";

// A-01/A-02 de la auditoría: el token de sesión ya NO vive en
// localStorage ni se manda por query string — vive en una cookie httpOnly
// que el navegador adjunta solo, y que JavaScript no puede leer ni robar
// vía un XSS. `credentials: "same-origin"` (el default de fetch, aquí
// explícito) es lo que hace que esa cookie viaje en cada petición; no hay
// nada más que gestionar desde el frontend.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  if (res.status === 401) {
    onUnauthorized();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Error ${res.status}`);
    Object.assign(err, body); // adjunta campos extra como `suggestion`, si el backend los manda
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  auth: {
    login: (data) => request(`/auth/login`, { method: "POST", body: JSON.stringify(data) }),
    logout: () => request(`/auth/logout`, { method: "POST" }),
    me: () => request(`/auth/me`),
    changePassword: (data) => request(`/auth/change-password`, { method: "POST", body: JSON.stringify(data) }),
  },
  users: {
    list: () => request(`/users`),
    create: (data) => request(`/users`, { method: "POST", body: JSON.stringify(data) }),
    update: (id, data) => request(`/users/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    remove: (id) => request(`/users/${id}`, { method: "DELETE" }),
    resetPassword: (id) => request(`/users/${id}/reset-password`, { method: "POST" }),
    suggestUsername: (desired) => request(`/users/suggest-username?desired=${encodeURIComponent(desired)}`),
  },
  patients: {
    list: (q) => request(`/patients${q ? `?q=${encodeURIComponent(q)}` : ""}`),
    get: (id) => request(`/patients/${id}`),
    create: (data) => request(`/patients`, { method: "POST", body: JSON.stringify(data) }),
    update: (id, data) => request(`/patients/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    nextHistoryNumber: () => request(`/patients/next-history-number`),
  },
  appointments: {
    listByDate: (date) => request(`/appointments?date=${date}`),
    create: (data) => request(`/appointments`, { method: "POST", body: JSON.stringify(data) }),
    setStatus: (id, status) =>
      request(`/appointments/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
    // Nuevo rol "enfermera": signos vitales de ingreso, ligados a la cita.
    setIntake: (id, data) => request(`/appointments/${id}/intake`, { method: "PUT", body: JSON.stringify(data) }),
  },
  consultations: {
    listByPatient: (patientId) => request(`/patients/${patientId}/consultations`),
    create: (data) => request(`/consultations`, { method: "POST", body: JSON.stringify(data) }),
    update: (id, data) => request(`/consultations/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    // Ya no borra: anula (requiere motivo) — ver C-04 de la auditoría.
    remove: (id, reason) => request(`/consultations/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) }),
  },
  cie11: {
    search: (q) => request(`/cie11?q=${encodeURIComponent(q)}`),
  },
  medications: {
    search: (q) => request(`/medications?q=${encodeURIComponent(q)}`),
  },
  doctorProfile: {
    get: () => request(`/doctor-profile`),
    update: (data) => request(`/doctor-profile`, { method: "PUT", body: JSON.stringify(data) }),
    updateBooking: (data) => request(`/doctor-profile/booking`, { method: "PUT", body: JSON.stringify(data) }),
    uploadLogo: (dataUri) => request(`/doctor-profile/logo`, { method: "PUT", body: JSON.stringify({ data_uri: dataUri }) }),
    removeLogo: () => request(`/doctor-profile/logo`, { method: "DELETE" }),
  },
  prescriptions: {
    listByPatient: (patientId) => request(`/prescriptions/patient/${patientId}`),
    get: (id) => request(`/prescriptions/${id}`),
    create: (data) => request(`/prescriptions`, { method: "POST", body: JSON.stringify(data) }),
    update: (id, data) => request(`/prescriptions/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    // Ya no borra: anula (requiere motivo) — ver C-04 de la auditoría.
    remove: (id, reason) => request(`/prescriptions/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) }),
    send: (id, channel) => request(`/prescriptions/${id}/send`, { method: "POST", body: JSON.stringify({ channel }) }),
    // Ya no lleva ?token= (A-02): la cookie httpOnly de sesión viaja sola
    // en la navegación normal (abrir en pestaña nueva / <a href>), sin
    // exponer el token de sesión en la URL, historial o logs.
    pdfUrl: (id) => `${BASE}/prescriptions/${id}/pdf`,
    shareRevoke: (id) => request(`/prescriptions/${id}/share/revoke`, { method: "POST" }),
    shareRotate: (id) => request(`/prescriptions/${id}/share/rotate`, { method: "POST" }),
  },
  certificates: {
    listByPatient: (patientId) => request(`/certificates/patient/${patientId}`),
    get: (id) => request(`/certificates/${id}`),
    create: (data) => request(`/certificates`, { method: "POST", body: JSON.stringify(data) }),
    update: (id, data) => request(`/certificates/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    // Ya no borra: anula (requiere motivo) — ver C-04 de la auditoría.
    remove: (id, reason) => request(`/certificates/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) }),
    send: (id, channel) => request(`/certificates/${id}/send`, { method: "POST", body: JSON.stringify({ channel }) }),
    pdfUrl: (id) => `${BASE}/certificates/${id}/pdf`,
    shareRevoke: (id) => request(`/certificates/${id}/share/revoke`, { method: "POST" }),
    shareRotate: (id) => request(`/certificates/${id}/share/rotate`, { method: "POST" }),
  },
  reminders: {
    getSettings: () => request(`/reminder-settings`),
    updateSettings: (data) => request(`/reminder-settings`, { method: "PUT", body: JSON.stringify(data) }),
    send: (appointmentId) => request(`/appointments/${appointmentId}/send-reminder`, { method: "POST" }),
  },
  notifications: {
    getSettings: () => request(`/notification-settings`),
    updateSettings: (data) => request(`/notification-settings`, { method: "PUT", body: JSON.stringify(data) }),
  },
};
