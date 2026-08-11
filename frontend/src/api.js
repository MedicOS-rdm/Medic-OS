const BASE = "/api";
const TOKEN_KEY = "ece_agenda_token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Se dispara cuando el backend responde 401 (sesión inválida/expirada) para
// que App.jsx pueda regresar a la pantalla de login.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  });
  if (res.status === 401) {
    setToken(null);
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
    me: () => request(`/auth/me`),
    changePassword: (data) => request(`/auth/change-password`, { method: "POST", body: JSON.stringify(data) }),
  },
  users: {
    list: () => request(`/users`),
    create: (data) => request(`/users`, { method: "POST", body: JSON.stringify(data) }),
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
  },
  consultations: {
    listByPatient: (patientId) => request(`/patients/${patientId}/consultations`),
    create: (data) => request(`/consultations`, { method: "POST", body: JSON.stringify(data) }),
    update: (id, data) => request(`/consultations/${id}`, { method: "PUT", body: JSON.stringify(data) }),
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
    uploadLogo: (dataUri) => request(`/doctor-profile/logo`, { method: "PUT", body: JSON.stringify({ data_uri: dataUri }) }),
    removeLogo: () => request(`/doctor-profile/logo`, { method: "DELETE" }),
  },
  prescriptions: {
    listByPatient: (patientId) => request(`/prescriptions/patient/${patientId}`),
    get: (id) => request(`/prescriptions/${id}`),
    create: (data) => request(`/prescriptions`, { method: "POST", body: JSON.stringify(data) }),
    update: (id, data) => request(`/prescriptions/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    pdfUrl: (id) => `${BASE}/prescriptions/${id}/pdf?token=${encodeURIComponent(getToken() || "")}`,
  },
  certificates: {
    listByPatient: (patientId) => request(`/certificates/patient/${patientId}`),
    get: (id) => request(`/certificates/${id}`),
    create: (data) => request(`/certificates`, { method: "POST", body: JSON.stringify(data) }),
    update: (id, data) => request(`/certificates/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    pdfUrl: (id) => `${BASE}/certificates/${id}/pdf?token=${encodeURIComponent(getToken() || "")}`,
  },
  reminders: {
    getSettings: () => request(`/reminder-settings`),
    updateSettings: (data) => request(`/reminder-settings`, { method: "PUT", body: JSON.stringify(data) }),
    send: (appointmentId) => request(`/appointments/${appointmentId}/send-reminder`, { method: "POST" }),
  },
};
