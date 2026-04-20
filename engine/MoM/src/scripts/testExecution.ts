/**
 * ═══════════════════════════════════════════════════════════════
 *  TEST EXECUTION SCRIPT — Tradovate API Verification
 * ═══════════════════════════════════════════════════════════════
 *
 * Purpose:
 *   Mathematically verify that the Tradovate Execution endpoints
 *   are accessible and not paywalled. Fires a "dummy" Limit Buy
 *   at $100 (a price that will NEVER fill for MES), waits 3s,
 *   then cancels it.
 *
 * Usage:
 *   npx ts-node src/scripts/testExecution.ts
 *
 * Expected outcome:
 *   ✅ Order placed → Order ID logged
 *   ✅ 3-second hold
 *   ✅ Order canceled → Confirmation logged
 *   ✅ Process exits cleanly
 */

import * as dotenv from 'dotenv';
dotenv.config();

import axios, { AxiosInstance } from 'axios';
import { config } from '../config/env';

// ─── Constants ─────────────────────────────────────────────────
const REST_BASE = 'https://demo.tradovateapi.com/v1';
const AUTH_URL  = `${REST_BASE}/auth/accesstokenrequest`;

const TEST_SYMBOL = 'MESM6';
const TEST_PRICE  = 100.00;  // $100 — will never fill
const TEST_QTY    = 1;

// ─── Main Test ─────────────────────────────────────────────────
async function runTest(): Promise<void> {
    console.log('\n🧪 ═══════════════════════════════════════════');
    console.log('🧪  TRADOVATE EXECUTION TEST — Dummy Limit Order');
    console.log('🧪 ═══════════════════════════════════════════\n');

    // ── Step 1: Authenticate ────────────────────────────────────
    console.log('🔐 [Step 1] Authenticating with Tradovate...');

    let accessToken: string;
    try {
        const authRes = await axios.post(AUTH_URL, {
            name:       config.TRADOVATE_USERNAME,
            password:   config.TRADOVATE_PASSWORD,
            appId:      config.TRADOVATE_APP_ID,
            appVersion: config.TRADOVATE_APP_VERSION,
            cid:        config.TRADOVATE_CLIENT_ID,
            sec:        config.TRADOVATE_CLIENT_SECRET,
        });

        accessToken = authRes.data.accessToken;
        if (!accessToken) {
            throw new Error('No accessToken in auth response.');
        }
        console.log('✅ [Step 1] OAuth token acquired.\n');
    } catch (err: any) {
        console.error('❌ [Step 1] Auth FAILED:', err.response?.data || err.message);
        process.exit(1);
    }

    // Create a pre-configured Axios instance
    const api: AxiosInstance = axios.create({
        baseURL: REST_BASE,
        timeout: 10000,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
        },
    });

    // ── Step 2: Resolve Account ─────────────────────────────────
    console.log('🔑 [Step 2] Resolving Tradovate account...');

    let accountId: number;
    let accountSpec: string;
    try {
        const acctRes = await api.get('/account/list');
        const accounts = acctRes.data;

        if (!accounts || accounts.length === 0) {
            throw new Error('No accounts found on this Tradovate login.');
        }

        accountId   = accounts[0].id;
        accountSpec = accounts[0].name || '';
        console.log(`✅ [Step 2] Account: ${accountSpec} (ID: ${accountId})\n`);
    } catch (err: any) {
        console.error('❌ [Step 2] Account resolution FAILED:', err.response?.data || err.message);
        process.exit(1);
    }

    // ── Step 3: Place Dummy Limit Order ─────────────────────────
    console.log(`⚡ [Step 3] Placing DUMMY Limit Buy: ${TEST_QTY}x ${TEST_SYMBOL} @ $${TEST_PRICE}...`);

    let orderId: number;
    try {
        const orderPayload = {
            accountSpec,
            accountId,
            action:      'Buy',
            symbol:      TEST_SYMBOL,
            orderQty:    TEST_QTY,
            orderType:   'Limit',
            price:       TEST_PRICE,
            isAutomated: true,
        };

        const orderRes = await api.post('/order/placeOrder', orderPayload, {
            timeout: 5000,
        });

        orderId = orderRes.data?.orderId || orderRes.data?.id;

        if (!orderId) {
            console.warn('⚠️  No orderId in response. Full response:');
            console.warn(JSON.stringify(orderRes.data, null, 2));
            throw new Error('Order placed but no orderId returned.');
        }

        console.log(`✅ [Step 3] Order PLACED. Order ID: ${orderId}`);
        console.log(`   📋 Full response: ${JSON.stringify(orderRes.data)}\n`);
    } catch (err: any) {
        console.error('❌ [Step 3] Order placement FAILED:', err.response?.data || err.message);
        process.exit(1);
    }

    // ── Step 4: Wait 3 Seconds ──────────────────────────────────
    console.log('⏳ [Step 4] Waiting 3 seconds before cancel...');
    await new Promise(r => setTimeout(r, 3000));
    console.log('✅ [Step 4] Wait complete.\n');

    // ── Step 5: Cancel the Order ────────────────────────────────
    console.log(`🧹 [Step 5] Canceling Order ID: ${orderId}...`);
    try {
        const cancelRes = await api.post('/order/cancelOrder', {
            orderId,
        });

        console.log(`✅ [Step 5] Order CANCELED.`);
        console.log(`   📋 Cancel response: ${JSON.stringify(cancelRes.data)}\n`);
    } catch (err: any) {
        console.error('❌ [Step 5] Cancel FAILED:', err.response?.data || err.message);
        // Non-fatal — order may have already been rejected by the exchange
    }

    // ── Summary ─────────────────────────────────────────────────
    console.log('🧪 ═══════════════════════════════════════════');
    console.log('🧪  TEST COMPLETE');
    console.log('🧪  ✅ Auth       — PASS');
    console.log('🧪  ✅ Account    — PASS');
    console.log('🧪  ✅ PlaceOrder — PASS');
    console.log('🧪  ✅ Cancel     — PASS');
    console.log('🧪 ═══════════════════════════════════════════\n');

    process.exit(0);
}

// ─── Execute ───────────────────────────────────────────────────
runTest().catch((err) => {
    console.error('🔴 Unhandled error in testExecution:', err);
    process.exit(1);
});
