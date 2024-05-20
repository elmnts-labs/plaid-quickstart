'use strict';

// read env vars from .env file
require('dotenv').config();
const {
  Configuration,
  PlaidApi,
  Products,
  PlaidEnvironments,
} = require('plaid');
const util = require('util');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const bodyParser = require('body-parser');
const moment = require('moment');
const cors = require('cors');
const { Keypair } = require('@solana/web3.js');
const nacl = require('tweetnacl');
const { decodeUTF8 } = require('tweetnacl-util');
const base58 = require('bs58');
const { bs58 } = require('@project-serum/anchor/dist/cjs/utils/bytes');
const { assert } = require('console');
const { create } = require('domain');

const APP_PORT = process.env.APP_PORT || 8000;
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';

// PLAID_PRODUCTS is a comma-separated list of products to use when initializing
// Link. Note that this list must contain 'assets' in order for the app to be
// able to create and retrieve asset reports.
const PLAID_PRODUCTS = (
  process.env.PLAID_PRODUCTS || Products.Transactions
).split(',');

// PLAID_COUNTRY_CODES is a comma-separated list of countries for which users
// will be able to select institutions from.
const PLAID_COUNTRY_CODES = (process.env.PLAID_COUNTRY_CODES || 'US').split(
  ',',
);

// Parameters used for the OAuth redirect Link flow.
//
// Set PLAID_REDIRECT_URI to 'http://localhost:3000'
// The OAuth redirect flow requires an endpoint on the developer's website
// that the bank website should redirect to. You will need to configure
// this redirect URI for your client ID through the Plaid developer dashboard
// at https://dashboard.plaid.com/team/api.
const PLAID_REDIRECT_URI = process.env.PLAID_REDIRECT_URI || '';

// Parameter used for OAuth in Android. This should be the package name of your app,
// e.g. com.plaid.linksample
const PLAID_ANDROID_PACKAGE_NAME = process.env.PLAID_ANDROID_PACKAGE_NAME || '';

// We store the access_token in memory - in production, store it in a secure
// persistent data store
let ACCESS_TOKEN = null;
let PUBLIC_TOKEN = null;
let ITEM_ID = null;
let ACCOUNT_ID = null;
// The payment_id is only relevant for the UK/EU Payment Initiation product.
// We store the payment_id in memory - in production, store it in a secure
// persistent data store along with the Payment metadata, such as userId .
let PAYMENT_ID = null;
// The transfer_id and authorization_id are only relevant for Transfer ACH product.
// We store the transfer_id in memory - in production, store it in a secure
// persistent data store
let AUTHORIZATION_ID = null;
let TRANSFER_ID = null;

// Initialize the Plaid client
// Find your API keys in the Dashboard (https://dashboard.plaid.com/account/keys)

const configuration = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
      'Plaid-Version': '2020-09-14',
    },
  },
});

const client = new PlaidApi(configuration);

const app = express();
app.use(
  bodyParser.urlencoded({
    extended: false,
  }),
);
app.use(bodyParser.json());
app.use(cors());

app.post('/api/info', function (request, response, next) {
  response.json({
    item_id: ITEM_ID,
    access_token: ACCESS_TOKEN,
    products: PLAID_PRODUCTS,
  });
});

// Create a link token with configs which we can then use to initialize Plaid Link client-side.
// See https://plaid.com/docs/#create-link-token
app.post('/api/create_link_token', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const configs = {
        user: {
          // This should correspond to a unique id for the current user.
          client_user_id: 'user-id',
        },
        client_name: 'Plaid Quickstart',
        products: PLAID_PRODUCTS,
        country_codes: PLAID_COUNTRY_CODES,
        language: 'en',
      };

      if (PLAID_REDIRECT_URI !== '') {
        configs.redirect_uri = PLAID_REDIRECT_URI;
      }

      if (PLAID_ANDROID_PACKAGE_NAME !== '') {
        configs.android_package_name = PLAID_ANDROID_PACKAGE_NAME;
      }
      if (PLAID_PRODUCTS.includes(Products.Statements)) {
        const statementConfig = {
          end_date: moment().format('YYYY-MM-DD'),
          start_date: moment().subtract(30, 'days').format('YYYY-MM-DD'),
        };
        configs.statements = statementConfig;
      }
      const createTokenResponse = await client.linkTokenCreate(configs);
      prettyPrintResponse(createTokenResponse);
      response.json(createTokenResponse.data);
    })
    .catch(next);
});

const signMessage = (message, keypair) => {
  const messageBytes = decodeUTF8(message);
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
  const result = nacl.sign.detached.verify(
    messageBytes,
    signature,
    keypair.publicKey.toBytes(),
  );

  assert(result);

  return signature;
};

const createMockUser = async () => {
  // generate keypair to simulate wallet
  const user = Keypair.generate();

  // get message to sign from coinflow
  const messageRes = await fetch('https://api-sandbox.coinflow.cash/api/auth', {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'x-coinflow-auth-blockchain': 'solana',
      'x-coinflow-auth-wallet': user.publicKey.toString(),
    },
  });

  const messageJson = await messageRes.json();
  const message = messageJson.message;

  // sign message
  const signatureBytes = signMessage(message, user);
  // encode to base58
  const signature = bs58.encode(signatureBytes);

  // send signature to coinflow
  // curl --request POST \
  //     --url https://api-sandbox.coinflow.cash/api/auth \
  //     --header 'accept: application/json' \
  //     --header 'content-type: application/json' \
  //     --header 'x-coinflow-auth-blockchain: solana' \
  //     --header 'x-coinflow-auth-wallet: 264tdkV22h64eQvxj2XkeV1MgTBSjDRQfzZEiq2UcVyB'
  //     --data '{"signature":"<signature>"}'
  const authRes = await fetch('https://api-sandbox.coinflow.cash/api/auth', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-coinflow-auth-blockchain': 'solana',
      'x-coinflow-auth-wallet': user.publicKey.toString(),
    },
    body: JSON.stringify({ signedMessage: signature }),
  });

  const authJson = await authRes.json();

  return {
    pubkey: user.publicKey.toString(),
    jwt: authJson.jwt,
  };
};

app.post(
  '/api/convert_plaid_public_token_to_coinflow_token',
  function (request, response, next) {
    PUBLIC_TOKEN = request.body.public_token;
    console.log('Public token: ', PUBLIC_TOKEN);

    Promise.resolve()
      .then(async function () {
        // Create test coinflow user
        // This helper generates a new keypair, signs a message from coinflow,
        // and returns the user's public key and coinflow jwt
        const user = await createMockUser();

        // Exchange token flow - exchange a Link public_token for
        // an API access_token
        // https://plaid.com/docs/#exchange-token-flow
        const tokenResponse = await client.itemPublicTokenExchange({
          public_token: PUBLIC_TOKEN,
        });

        prettyPrintResponse(tokenResponse);
        ACCESS_TOKEN = tokenResponse.data.access_token;
        ITEM_ID = tokenResponse.data.item_id;

        // Retrieve ACH or ETF Auth data for an Item's accounts
        // https://plaid.com/docs/#auth
        const authResponse = await client.authGet({
          access_token: ACCESS_TOKEN,
        });

        prettyPrintResponse(authResponse);

        if (!authResponse.data.accounts.length > 0) {
          response.json({ error: 'No accounts found' });
          return;
        }

        const type = authResponse.data.accounts[0].subtype;
        const routingNumber = authResponse.data.numbers.ach[0].routing;
        const accountNumber = authResponse.data.numbers.ach[0].account;
        const accountName = authResponse.data.accounts[0].name;
        const accountId = authResponse.data.accounts[0].account_id;

        console.log('WE GOT HERE!');

        // Add bank account data to coinflow with the following curl:
        //      curl --request POST \
        //     --url https://api-sandbox.coinflow.cash/api/customer/bankAccount \
        //      --header 'Authorization: 2yWZ1iUyhmUUWfwKVXnSLXAFx4YhWWc8Lr129xQDVudw' \
        //      --header 'content-type: application/json' \
        //      --data '
        // {
        //   "type": "checking",
        //   "blockchain": "solana",
        //   "routingNumber": "1111111111",
        //   "account_number": "22222222222",
        //   "email": "test@email.com",
        //   "firstName": "testFirstName",
        //   "lastName": "testLastName",
        //   "address1": "123 Main street",
        //   "city": "white plains",
        //   "state": "new york",
        //   "zip": "10601",
        //   "alias": "checking",
        //   "plaidAccountId": "12345",
        //   "plaidAccessToken": "12345",
        //   "wallet": "2yWZ1iUyhmUUWfwKVXnSLXAFx4YhWWc8Lr129xQDVudw"
        // }
        // '

const addBankBody = {
  type,
  blockchain: 'solana',
  routingNumber: routingNumber,
  account_number: accountNumber,
  email: 'test@email.com',
  firstName: 'test',
  lastName: 'user',
  address1: '123 Main St',
  city: 'White Plains',
  state: 'NY',
  zip: '10601',
  alias: accountName,
  plaidAccountId: accountId,
  plaidAccessToken: ACCESS_TOKEN,
  wallet: user.pubkey,
};

        console.log(addBankBody);

const coinflowRes = await fetch(
  'https://api-sandbox.coinflow.cash/api/customer/bankAccount/',
  {
    method: 'POST',
    headers: {
      Authorization:
        'coinflow_sandbox_2e5980224585456aaf5e8fc43a111de1_e3965f2985164235891596e15cfb9711',
      'content-type': 'application/json',
    },
    body: JSON.stringify(addBankBody),
  },
);

        assert(coinflowRes.status === 200);

        console.log(user.jwt);
        // Fetch customer from coinflow
        // curl --request GET \
        //     --url https://api-sandbox.coinflow.cash/api/customer \
        //     --header 'Authorization: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ3YWxsZXQiOiJHVEhwckFNYVZZQnpNOGtmdlF5Q1dzMURFMm85eDVuSkVEUHRva3lkWDdqcCIsImJsb2NrY2hhaW4iOiJzb2xhbmEiLCJpYXQiOjE3MTUyMTgxNDYsImV4cCI6MTcxNTMwNDU0Nn0.hG9I_NF303TO3iVFz_90l-Hmzo0ZSp0o-mgrrs6QUeE' \
        //     --header 'accept: application/json'
const customerRes = await fetch(
  'https://api-sandbox.coinflow.cash/api/customer',
  {
    method: 'GET',
    headers: {
      Authorization: user.jwt,
      accept: 'application/json',
      'x-coinflow-auth-wallet': user.pubkey,
      'x-coinflow-auth-blockchain': 'solana',
    },
  },
);

        const customerJson = await customerRes.json();
        console.log(JSON.stringify(customerJson));
        // const json = await coinflowRes.json();
        // console.log(json);

        response.json({});
      })
      .catch(next);
  },
);

// Exchange token flow - exchange a Link public_token for
// an API access_token
// https://plaid.com/docs/#exchange-token-flow
app.post('/api/set_access_token', function (request, response, next) {
  PUBLIC_TOKEN = request.body.public_token;
  Promise.resolve()
    .then(async function () {
      const tokenResponse = await client.itemPublicTokenExchange({
        public_token: PUBLIC_TOKEN,
      });
      prettyPrintResponse(tokenResponse);
      ACCESS_TOKEN = tokenResponse.data.access_token;
      ITEM_ID = tokenResponse.data.item_id;
      response.json({
        // the 'access_token' is a private token, DO NOT pass this token to the frontend in your production environment
        access_token: ACCESS_TOKEN,
        item_id: ITEM_ID,
        error: null,
      });
    })
    .catch(next);
});

// Retrieve ACH or ETF Auth data for an Item's accounts
// https://plaid.com/docs/#auth
app.get('/api/auth', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const authResponse = await client.authGet({
        access_token: ACCESS_TOKEN,
      });
      console.log(1);
      prettyPrintResponse(authResponse);
      response.json(authResponse.data);
    })
    .catch(next);
});

// Retrieve Identity for an Item
// https://plaid.com/docs/#identity
app.get('/api/identity', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const identityResponse = await client.identityGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(identityResponse);
      response.json({ identity: identityResponse.data.accounts });
    })
    .catch(next);
});

// Retrieve real-time Balances for each of an Item's accounts
// https://plaid.com/docs/#balance
app.get('/api/balance', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const balanceResponse = await client.accountsBalanceGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(balanceResponse);
      response.json(balanceResponse.data);
    })
    .catch(next);
});

// Retrieve Holdings for an Item
// https://plaid.com/docs/#investments
app.get('/api/holdings', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const holdingsResponse = await client.investmentsHoldingsGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(holdingsResponse);
      response.json({ error: null, holdings: holdingsResponse.data });
    })
    .catch(next);
});

// Retrieve Liabilities for an Item
// https://plaid.com/docs/#liabilities
app.get('/api/liabilities', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const liabilitiesResponse = await client.liabilitiesGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(liabilitiesResponse);
      response.json({ error: null, liabilities: liabilitiesResponse.data });
    })
    .catch(next);
});

// Retrieve information about an Item
// https://plaid.com/docs/#retrieve-item
app.get('/api/item', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      // Pull the Item - this includes information about available products,
      // billed products, webhook information, and more.
      const itemResponse = await client.itemGet({
        access_token: ACCESS_TOKEN,
      });
      // Also pull information about the institution
      const configs = {
        institution_id: itemResponse.data.item.institution_id,
        country_codes: PLAID_COUNTRY_CODES,
      };
      const instResponse = await client.institutionsGetById(configs);
      prettyPrintResponse(itemResponse);
      response.json({
        item: itemResponse.data.item,
        institution: instResponse.data.institution,
      });
    })
    .catch(next);
});

// Retrieve an Item's accounts
// https://plaid.com/docs/#accounts
app.get('/api/accounts', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const accountsResponse = await client.accountsGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(accountsResponse);
      response.json(accountsResponse.data);
    })
    .catch(next);
});

// Create and then retrieve an Asset Report for one or more Items. Note that an
// Asset Report can contain up to 100 items, but for simplicity we're only
// including one Item here.
// https://plaid.com/docs/#assets
app.get('/api/assets', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      // You can specify up to two years of transaction history for an Asset
      // Report.
      const daysRequested = 10;

      // The `options` object allows you to specify a webhook for Asset Report
      // generation, as well as information that you want included in the Asset
      // Report. All fields are optional.
      const options = {
        client_report_id: 'Custom Report ID #123',
        // webhook: 'https://your-domain.tld/plaid-webhook',
        user: {
          client_user_id: 'Custom User ID #456',
          first_name: 'Alice',
          middle_name: 'Bobcat',
          last_name: 'Cranberry',
          ssn: '123-45-6789',
          phone_number: '555-123-4567',
          email: 'alice@example.com',
        },
      };
      const configs = {
        access_tokens: [ACCESS_TOKEN],
        days_requested: daysRequested,
        options,
      };
      const assetReportCreateResponse = await client.assetReportCreate(configs);
      prettyPrintResponse(assetReportCreateResponse);
      const assetReportToken =
        assetReportCreateResponse.data.asset_report_token;
      const getResponse = await getAssetReportWithRetries(
        client,
        assetReportToken,
      );
      const pdfRequest = {
        asset_report_token: assetReportToken,
      };

      const pdfResponse = await client.assetReportPdfGet(pdfRequest, {
        responseType: 'arraybuffer',
      });
      prettyPrintResponse(getResponse);
      prettyPrintResponse(pdfResponse);
      response.json({
        json: getResponse.data.report,
        pdf: pdfResponse.data.toString('base64'),
      });
    })
    .catch(next);
});

app.get('/api/statements', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const statementsListResponse = await client.statementsList({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(statementsListResponse);
      const pdfRequest = {
        access_token: ACCESS_TOKEN,
        statement_id:
          statementsListResponse.data.accounts[0].statements[0].statement_id,
      };

      const statementsDownloadResponse = await client.statementsDownload(
        pdfRequest,
        {
          responseType: 'arraybuffer',
        },
      );
      prettyPrintResponse(statementsDownloadResponse);
      response.json({
        json: statementsListResponse.data,
        pdf: statementsDownloadResponse.data.toString('base64'),
      });
    })
    .catch(next);
});

// This functionality is only relevant for the UK/EU Payment Initiation product.
// Retrieve Payment for a specified Payment ID
app.get('/api/payment', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const paymentGetResponse = await client.paymentInitiationPaymentGet({
        payment_id: PAYMENT_ID,
      });
      prettyPrintResponse(paymentGetResponse);
      response.json({ error: null, payment: paymentGetResponse.data });
    })
    .catch(next);
});

// This endpoint is still supported but is no longer recommended
// For Income best practices, see https://github.com/plaid/income-sample instead
app.get(
  '/api/income/verification/paystubs',
  function (request, response, next) {
    Promise.resolve()
      .then(async function () {
        const paystubsGetResponse = await client.incomeVerificationPaystubsGet({
          access_token: ACCESS_TOKEN,
        });
        prettyPrintResponse(paystubsGetResponse);
        response.json({ error: null, paystubs: paystubsGetResponse.data });
      })
      .catch(next);
  },
);

app.use('/api', function (error, request, response, next) {
  console.log(error);
  prettyPrintResponse(error.response);
  response.json(formatError(error.response));
});

const server = app.listen(APP_PORT, function () {
  console.log('plaid-quickstart server listening on port ' + APP_PORT);
});

const prettyPrintResponse = (response) => {
  console.log(util.inspect(response.data, { colors: true, depth: 4 }));
};

// This is a helper function to poll for the completion of an Asset Report and
// then send it in the response to the client. Alternatively, you can provide a
// webhook in the `options` object in your `/asset_report/create` request to be
// notified when the Asset Report is finished being generated.

const getAssetReportWithRetries = (
  plaidClient,
  asset_report_token,
  ms = 1000,
  retriesLeft = 20,
) =>
  new Promise((resolve, reject) => {
    const request = {
      asset_report_token,
    };

    plaidClient
      .assetReportGet(request)
      .then(resolve)
      .catch(() => {
        setTimeout(() => {
          if (retriesLeft === 1) {
            reject('Ran out of retries while polling for asset report');
            return;
          }
          getAssetReportWithRetries(
            plaidClient,
            asset_report_token,
            ms,
            retriesLeft - 1,
          ).then(resolve);
        }, ms);
      });
  });

const formatError = (error) => {
  return {
    error: { ...error.data, status_code: error.status },
  };
};

app.get('/api/transfer_authorize', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const accountsResponse = await client.accountsGet({
        access_token: ACCESS_TOKEN,
      });
      ACCOUNT_ID = accountsResponse.data.accounts[0].account_id;

      const transferAuthorizationCreateResponse =
        await client.transferAuthorizationCreate({
          access_token: ACCESS_TOKEN,
          account_id: ACCOUNT_ID,
          type: 'debit',
          network: 'ach',
          amount: '1.00',
          ach_class: 'ppd',
          user: {
            legal_name: 'FirstName LastName',
            email_address: 'foobar@email.com',
            address: {
              street: '123 Main St.',
              city: 'San Francisco',
              region: 'CA',
              postal_code: '94053',
              country: 'US',
            },
          },
        });
      prettyPrintResponse(transferAuthorizationCreateResponse);
      AUTHORIZATION_ID =
        transferAuthorizationCreateResponse.data.authorization.id;
      response.json(transferAuthorizationCreateResponse.data);
    })
    .catch(next);
});

app.get('/api/transfer_create', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const transferCreateResponse = await client.transferCreate({
        access_token: ACCESS_TOKEN,
        account_id: ACCOUNT_ID,
        authorization_id: AUTHORIZATION_ID,
        description: 'Debit',
      });
      prettyPrintResponse(transferCreateResponse);
      TRANSFER_ID = transferCreateResponse.data.transfer.id;
      response.json({
        error: null,
        transfer: transferCreateResponse.data.transfer,
      });
    })
    .catch(next);
});

app.get('/api/signal_evaluate', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const accountsResponse = await client.accountsGet({
        access_token: ACCESS_TOKEN,
      });
      ACCOUNT_ID = accountsResponse.data.accounts[0].account_id;

      const signalEvaluateResponse = await client.signalEvaluate({
        access_token: ACCESS_TOKEN,
        account_id: ACCOUNT_ID,
        client_transaction_id: 'txn1234',
        amount: 100.0,
      });
      prettyPrintResponse(signalEvaluateResponse);
      response.json(signalEvaluateResponse.data);
    })
    .catch(next);
});
