// k6 load test for the storefront.
//   k6 run -e BASE_URL=http://localhost:3000 -e HANDLE=<a published handle> load/storefront.js
// Run once idle and once while a 10,000-row import is processing, then compare p95.
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const HANDLE = __ENV.HANDLE || "hand-thrown-terracotta-planter";
const COUNTRIES = ["de", "fr", "at", "us", "jp"];

export const options = {
  scenarios: {
    shoppers: { executor: "constant-vus", vus: Number(__ENV.VUS || 100), duration: __ENV.DURATION || "2m" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{page:product}": ["p(95)<150"],
    "http_req_duration{page:collection}": ["p(95)<150"],
  },
};

export default function () {
  const country = COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)];
  const collection = http.get(`${BASE}/store/${country}`, { tags: { page: "collection" } });
  check(collection, { "collection 200": (r) => r.status === 200 });
  const product = http.get(`${BASE}/store/${country}/products/${HANDLE}`, { tags: { page: "product" } });
  check(product, { "product 200": (r) => r.status === 200 });
  sleep(0.5);
}
