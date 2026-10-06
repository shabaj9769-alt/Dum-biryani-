# Vercel API (jab Firebase band karo)

`data.js` me `MODE='api'` karne par app ye endpoints bulata hai. Sab JSON.
Database Vercel ka (Postgres / Supabase / Upstash) rakho, Firebase ka data export karke daalo.

## Public (bina login)
| Call | Kaam |
|---|---|
| `GET /api/time` | `{now: <server ms>}` — shop ka time isi se chalta hai |
| `GET /api/data/settings` `menu` `categories` `banners` | customer app ka data |
| `POST /api/data/orders` | naya order / enquiry |
| `GET /api/data/orders?orderBy=phone&equalTo=<10 digit>` | order track (sirf safe fields) |

## Admin (cookie login zaroori)
`POST /api/login {password}` · `POST /api/logout` · `GET /api/me`
`GET|PUT|PATCH|POST|DELETE /api/data/<path>` — `orders`, `menu/<id>`, `categories/<id>`, `banners/<id>`, `settings`.
`PATCH /api/data/` (khali path) = multi-path update, jaise `{"categories/x":{...},"menu/y/category":"New"}`.
Value `{".sv":"timestamp"}` aaye to server asli time daal de. `null` = field delete.

## Server par ye checks ZAROOR lagao (abhi ye sirf browser me hain)
1. **Order price:** client ka price/total mat maano. Items ki qty lo, price DB ke menu se nikalo, total + delivery khud banao.
2. **Shop time:** Daily order sirf `shopOpen`–`shopClose` (IST) me, time bhi isi ke andar. Booking: `bookMinDays` se pehle ki date reject.
3. **Delivery radius:** `custLat/custLng` se doori khud nikalo (haversine) aur `dailyKm` / `bookKm` se compare karo.
4. **Delivery charge:** `dailyCharge/dailyFree`, `bookCharge/bookFree` se server hisaab kare.
5. **Order create par:** `ts`=server time, `status`='New' zabardasti, qty ki limit, phone 10 digit, sold-out dish reject, rate-limit (IP/phone).
6. **Track by phone:** sirf `status, items, total, date, time, ts, orderType` wapas do. Address, notes, lat/lng kabhi nahi.
7. **Admin routes:** cookie `HttpOnly; Secure; SameSite=Strict`, password env variable me (code me nahi), galat try par delay.
8. Customer ko `orders` ki poori list kabhi mat do.

## Shift karne ka order
1. Backend + database banao, Firebase data import karo.
2. `data.js` me `MODE='api'`, dono HTML se firebase `<script>` tags hatao, test karo.
3. Sab theek chale to hi Firebase rules `read:false, write:false` karo.

## My Orders (order code, bina login)
Order par `tracking/<code>` banta hai (code = `DB-` + 8 random akshar). Customer ke phone me code `localStorage('dbCodes')` me apne aap save hota hai; doosre phone par wo code daal kar order dekh sakta hai. API mode me: `GET /api/data/tracking/<code>` sirf us ek code ka record de; `tracking` ki poori list kabhi nahi. `POST /api/cancel {code}` se cancel (cooking se pehle). Email/login nahi.
