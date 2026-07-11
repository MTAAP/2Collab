import { secureHeaders } from "hono/secure-headers";

export function foundationSecurityHeaders() {
  return secureHeaders({
    contentSecurityPolicy: {
      baseUri: ["'none'"],
      defaultSrc: ["'self'"],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
    },
    referrerPolicy: "no-referrer",
  });
}
