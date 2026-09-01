import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit } from "../src/rateLimiter.js";

// A-04 de la auditoría: no había ninguna defensa contra fuerza bruta.
function fakeReqRes(ip, path = "/x") {
  const req = { ip, baseUrl: "", path };
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return { req, res };
}

test("rateLimit deja pasar peticiones dentro del límite", () => {
  const limiter = rateLimit({ windowMs: 60000, max: 3, message: "muchos intentos" });
  for (let i = 0; i < 3; i++) {
    const { req, res } = fakeReqRes("1.2.3.4");
    let calledNext = false;
    limiter(req, res, () => {
      calledNext = true;
    });
    assert.equal(calledNext, true, `intento ${i + 1} debería pasar`);
  }
});

test("rateLimit bloquea con 429 tras superar el máximo", () => {
  const limiter = rateLimit({ windowMs: 60000, max: 2, message: "muchos intentos" });
  const ip = "5.6.7.8";
  for (let i = 0; i < 2; i++) {
    const { req, res } = fakeReqRes(ip);
    limiter(req, res, () => {});
  }
  const { req, res } = fakeReqRes(ip);
  let calledNext = false;
  limiter(req, res, () => {
    calledNext = true;
  });
  assert.equal(calledNext, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, "muchos intentos");
  assert.ok(res.headers["Retry-After"], "debe indicar cuánto esperar");
});

test("rateLimit lleva cupos separados por IP", () => {
  const limiter = rateLimit({ windowMs: 60000, max: 1, message: "no" });
  const a = fakeReqRes("1.1.1.1");
  const b = fakeReqRes("2.2.2.2");
  let aOk = false;
  let bOk = false;
  limiter(a.req, a.res, () => (aOk = true));
  limiter(b.req, b.res, () => (bOk = true));
  assert.equal(aOk, true);
  assert.equal(bOk, true, "una IP distinta no debería heredar el cupo de otra");
});

test("rateLimit lleva cupos separados por ruta", () => {
  const limiter = rateLimit({ windowMs: 60000, max: 1, message: "no" });
  const ip = "9.9.9.9";
  const login = fakeReqRes(ip, "/login");
  const other = fakeReqRes(ip, "/other");
  let loginOk = false;
  let otherOk = false;
  limiter(login.req, login.res, () => (loginOk = true));
  limiter(other.req, other.res, () => (otherOk = true));
  assert.equal(loginOk, true);
  assert.equal(otherOk, true, "una ruta distinta no debería heredar el cupo de otra");
});
