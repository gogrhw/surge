/**
 * Surge MITM - Unlock GoodNotes & Notability premium subscriptions.
 */

const isReceipts = $request.url.includes("receipts");

const body = isReceipts
  ? {
      data: {
        processAppleReceipt: {
          __typename: "SubscriptionResult",
          isClassic: false,
          subscription: {
            productId: "com.goodnotes.gn6_one_time_unlock_3999",
            originalTransactionId: "480001475200",
            tier: "premium",
            refundedDate: null,
            refundedReason: null,
            isInBillingRetryPeriod: false,
            expirationDate: "2099-12-31T12:13:14.000Z",
            gracePeriodExpiresAt: null,
            overDeviceLimit: false,
            expirationIntent: "customer_cancelled",
            __typename: "Subscription",
            user: null,
            status: "active",
            originalPurchaseDate: "2024-01-11T04:08:20Z",
          },
          error: 0,
        },
      },
    }
  : {
      request_date: "2022-09-08T01:04:17Z",
      request_date_ms: 17406524731653,
      subscriber: {
        entitlements: {
          apple_access: {
            grace_period_expires_date: null,
            purchase_date: "2022-09-08T01:04:17Z",
            product_identifier: "notability_subscription_promium",
          },
          gn5: {
            grace_period_expires_date: null,
            purchase_date: "2022-09-08T01:04:17Z",
            product_identifier: "com.gingerlabs.Notability.gn5_full_access",
          },
          crossplatform_access: {
            grace_period_expires_date: null,
            purchase_date: "2023-12-31T13:14:20Z",
            product_identifier: "notability.crossplatform",
          },
        },
        first_seen: "2025-02-21T15:10:07Z",
        last_seen: "2025-02-21T15:10:07Z",
        management_: null,
        original_app_user_id: "BCDF398F-A451-44D0-B2E2-57F8D6A2C2EB",
        original_application_version: "1.2.3",
        original_purchase_date: "2023-12-31T13:14:20Z",
        subscriptions: {
          "com.goodnotes.gn6_one_time_unlock_3999": {
            is_sandbox: false,
            ownership_type: "PURCHASED",
            billing_issues_detected_at: null,
            period_type: "normal",
            grace_period_expires_at: null,
            unsubscribe_detected_at: null,
            original_purchase_date: "2024-01-11T04:08:20Z",
            purchase_date: "2024-01-11T04:08:20Z",
            store: "app_store",
          },
        },
      },
    };

$done({ body: JSON.stringify(body) });
