require("dotenv").config();
// Do not log secrets to the console. Log only presence to help debugging.
console.log("Loaded environment variables (secrets hidden)");

const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const {
  CONSUMER_KEY,
  CONSUMER_SECRET,
  BUSINESS_SHORTCODE,
  MPESA_PASSKEY,
  CALLBACK_URL,
  MPESA_ENV
} = process.env;

const MPESA_MOCK = (process.env.MPESA_MOCK || 'false').toLowerCase() === 'true';

// Simple presence checks (do not expose secret values)
const missingVars = [];
for (const v of ["CONSUMER_KEY", "CONSUMER_SECRET", "BUSINESS_SHORTCODE", "MPESA_PASSKEY", "CALLBACK_URL"]) {
  if (!process.env[v]) missingVars.push(v);
}
if (missingVars.length) {
  console.warn("Warning: Missing environment variables:", missingVars.join(", "));
}

// ✅ Base URLs for Sandbox or Production
const baseURL =
  MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

console.log(`Running in ${MPESA_ENV || "sandbox"} mode`);
console.log(`Using base URL: ${baseURL}`);
if (MPESA_MOCK) console.log('MPESA_MOCK is enabled — running in simulated mode (no external calls)');

// ✅ Get M-PESA access token
async function getAccessToken() {
  if (MPESA_MOCK) {
    // Return a dummy token in mock mode
    return 'mock-access-token';
  }

  if (!CONSUMER_KEY || !CONSUMER_SECRET) {
    console.error("Cannot fetch access token: missing CONSUMER_KEY or CONSUMER_SECRET");
    return null;
  }

  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");

  try {
    const response = await axios.get(
      `${baseURL}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      }
    );

    // Log only the presence of token, not the token itself
    console.log("Fetched access token successfully");
    return response.data.access_token;
  } catch (error) {
    console.error("Error fetching token:", error.response?.data?.error_description || error.response?.data || error.message);
    return null;
  }
}

// ✅ STK Push
app.post("/api/pay", async (req, res) => {
  const { phone, amount, name } = req.body;
  // Basic validation
  if (!phone || !amount) {
    return res.status(400).json({ success: false, message: "Missing phone or amount in request body." });
  }

  // If mock mode is enabled, short-circuit and return simulated success (no token, no remote call)
  if (MPESA_MOCK) {
    console.log('MPESA_MOCK enabled - returning simulated STK success (no external call)');
    return res.json({ success: true, message: 'STK Push sent to phone. (mock)' });
  }

  try {
    let access_token = await getAccessToken();
    if (!access_token) {
      return res.status(500).json({ success: false, message: "Server not configured to fetch access token. Check environment variables." });
    }
    // Log masked token for debug (do not reveal full token)
    try { console.log('Access token (masked):', access_token ? access_token.slice(0,6) + '...' : 'none'); } catch(e){}
    if (!access_token) {
      return res.status(500).json({ success: false, message: "Server not configured to fetch access token. Check environment variables." });
    }

    // normalize phone to 2547XXXXXXXX
    const normalizePhone = (p) => {
      if (!p) return p;
      let s = String(p).trim();
      s = s.replace(/\s+/g, "");
      if (s.startsWith('+')) s = s.slice(1);
      if (s.startsWith('0')) s = '254' + s.slice(1);
      if (!s.startsWith('254')) {
        // if user passed short number like 7XXXXXXXX, assume Kenya and prefix 254
        if (/^7\d{8}$/.test(s)) s = '254' + s;
      }
      return s;
    };

    const partyA = normalizePhone(phone);
    const phoneNumber = partyA;

    const timestamp = new Date().toISOString().replace(/[-T:\.Z]/g, "").slice(0, 14);
    const password = Buffer.from(`${BUSINESS_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString("base64");

    const payload = {
      BusinessShortCode: BUSINESS_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: partyA,
      PartyB: BUSINESS_SHORTCODE,
      PhoneNumber: phoneNumber,
      CallBackURL: CALLBACK_URL,
      AccountReference: "MPESA_PAYMENT",
      TransactionDesc: `Payment by ${name || 'customer'}`,
    };

    const stkRequest = async (token) =>
      await axios.post(
        `${baseURL}/mpesa/stkpush/v1/processrequest`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      );

    let response;
    try {
      if (MPESA_MOCK) {
        // Simulate a successful STK push response
        response = { data: { ResponseCode: '0', CustomerMessage: 'Success. Request accepted for processing' } };
        console.log('Simulated STK Push response (mock)');
      } else {
        response = await stkRequest(access_token);
      }
    } catch (err) {
      // Check for invalid access token and retry once
      const remote = err.response?.data;
      if (remote && (remote.errorCode === '404.001.03' || /Invalid Access Token/i.test(remote.errorMessage || ''))) {
        console.warn('Invalid access token detected from M-PESA, attempting to refresh token and retry STK once');
        access_token = await getAccessToken();
        if (access_token) {
          try {
            response = await stkRequest(access_token);
          } catch (err2) {
            console.error('STK retry failed:', err2.response?.data || err2.message);
            return res.status(502).json({ success: false, message: 'STK request failed after token refresh', details: err2.response?.data || err2.message });
          }
        } else {
          return res.status(502).json({ success: false, message: 'Unable to refresh access token. Check credentials.' });
        }
      } else {
        // Non-token-related error; surface it
        console.error('STK request error:', remote || err.message);
        return res.status(502).json({ success: false, message: 'STK request failed', details: remote || err.message });
      }
    }

    console.log("STK Push response received");

    if (response.data && response.data.ResponseCode === "0") {
      res.json({ success: true, message: "STK Push sent to phone." });
    } else {
      // Return the remote response details but avoid leaking internal server stack
      res.status(400).json({
        success: false,
        message: "Failed to send STK Push.",
        details: response.data || null,
      });
    }
  } catch (error) {
    console.error("M-PESA Error:", error.response?.data || error.message);
    res.status(500).json({ success: false, message: "Server error while processing payment." });
  }
});

// Debug endpoint: check access token (masked) without performing STK
app.get('/api/token', async (req, res) => {
  if (MPESA_MOCK) {
    return res.json({ success: true, message: 'Fetched access token (mock)', token: 'mock-a...' });
  }
  try {
    const token = await getAccessToken();
    if (!token) return res.status(502).json({ success: false, message: 'Unable to fetch access token. Check credentials.' });
    return res.json({ success: true, message: 'Fetched access token', token: token.slice(0,6) + '...' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error fetching token', details: err.message || err });
  }
});

// Real M-PESA callback receiver (logs the callback).
app.post('/mpesa/callback', express.json(), (req, res) => {
  console.log('Received M-PESA callback:', req.body);
  // store or process the callback as needed; respond 200 OK to Safaricom
  return res.json({ success: true });
});

// Demo helper: simulate a callback from M-PESA (so you can demo the callback handling)
app.post('/simulate-callback', express.json(), (req, res) => {
  const sample = {
    Body: {
      stkCallback: {
        MerchantRequestID: '12345',
        CheckoutRequestID: 'ABCDE',
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: req.body.amount || 10 },
            { Name: 'MpesaReceiptNumber', Value: 'ABC123XYZ' },
            { Name: 'PhoneNumber', Value: req.body.phone || '254708374149' }
          ]
        }
      }
    }
  };

  console.log('Simulated callback generated:', sample);
  return res.json({ success: true, callback: sample });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`M-PESA backend running on port ${PORT}`);
});
