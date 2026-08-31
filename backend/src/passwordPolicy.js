// Política de contraseñas compartida por login/registro (auth.js,
// admin.js, users.js). Antes el mínimo era 6 caracteres sin ningún otro
// requisito — insuficiente para cuentas con acceso a expedientes clínicos
// (A-06 de la auditoría). Se sube a 10 caracteres y se exige mezclar
// letras y números, sin llegar a reglas tan estrictas que inviten a
// anotar la contraseña en un papel.
export const MIN_PASSWORD_LENGTH = 10;

export function passwordPolicyError(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "La contraseña debe combinar letras y números.";
  }
  return null;
}
