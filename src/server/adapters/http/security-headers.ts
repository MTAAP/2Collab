import { secureHeaders } from "hono/secure-headers";

export function foundationSecurityHeaders() {
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
    },
    referrerPolicy: "no-referrer",
  });
}
