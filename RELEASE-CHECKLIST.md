# BeautyBook release preparation

## Web and AI preview on Render

1. Push this project to a private or public GitHub repository without API keys, `.env` files, signing keys, or passwords.
2. In Render, create a new Blueprint from the repository and review `render.yaml`. It provisions the free web service named `beautybook`; free services can sleep when idle and take time to wake.
3. In the service's Environment settings, add `OPENAI_API_KEY` as a secret. Keep `OPENAI_IMAGE_MODEL=gpt-image-1` unless the provider confirms another image-edit model is enabled for the account. Image-generation requests incur provider charges.
4. Wait for `/healthz` to report `{"status":"ok"}`. Check `https://<render-service>.onrender.com/try-on.html` and `https://<render-service>.onrender.com/privacy.html`. Health status confirms the web process is running; it does not confirm provider credentials or image-generation access.
5. Replace the draft privacy page placeholders, verify provider retention/settings, and add monitoring, durable per-account quotas/rate limits, abuse controls, and cost budgets before public launch. The included three-per-minute in-memory IP throttling is only a starter safeguard and resets on restarts.
6. Use a custom domain and HTTPS for the final public service. Configure any future website origin/API separation with an explicit CORS/CSRF design before changing the same-origin endpoint.

## Android and Google Play

The Android app sends an image to the same HTTPS API only after a person explicitly chooses a hairstyle preview. Set the final Render URL at build time; never put provider API keys in the app:

```powershell
$env:BEAUTYBOOK_API_BASE_URL = "https://<render-service>.onrender.com"
.\gradlew.bat :app:bundleRelease
```

For a Play upload-signed bundle, set all four values from your securely stored upload key:

```powershell
$env:BEAUTYBOOK_UPLOAD_STORE_FILE = "$env:USERPROFILE\beautybook-upload.jks"
$env:BEAUTYBOOK_API_BASE_URL = "https://<render-service>.onrender.com"
$env:BEAUTYBOOK_UPLOAD_KEY_ALIAS = "beautybook-upload"
$storePassword = Read-Host "Upload-key password" -AsSecureString
$env:BEAUTYBOOK_UPLOAD_STORE_PASSWORD = [System.Net.NetworkCredential]::new("", $storePassword).Password
$keyPassword = Read-Host "Upload-key entry password" -AsSecureString
$env:BEAUTYBOOK_UPLOAD_KEY_PASSWORD = [System.Net.NetworkCredential]::new("", $keyPassword).Password
.\gradlew.bat :app:bundleRelease
```

If this is the first release and you do not already have an upload key, create one interactively outside the project. Keytool prompts for passwords and certificate details; do not put passwords on the command line:

```powershell
keytool -genkeypair -v -keystore "$env:USERPROFILE\beautybook-upload.jks" -storetype JKS -keyalg RSA -keysize 2048 -validity 10000 -alias beautybook-upload
```

Keep the key and passwords in secure backups, never commit or send them in chat, and follow the Google Play App Signing enrollment flow. Output: `app/build/outputs/bundle/release/app-release.aab`. If no signing variables are set, Gradle builds an **unsigned validation bundle only**; it cannot be uploaded to Play.

The current local release bundle is unsigned and has no production Render URL configured, so it is not an upload-ready artifact yet. Rebuild only after the Render service URL and upload-key credentials are available.

Before submitting to Google Play, the account owner must finalize the unique app identity, store listing and contact details, developer-account verification, content/target-audience declarations, data-safety form, privacy-policy URL, age rating, signing, and review access. The draft guardian checkbox is not verified parental consent. Do not list or distribute the app to children under 13 until child-privacy and Families-policy requirements have been implemented and reviewed. Test the signed build against the deployed HTTPS service on supported devices.

## Remaining launch gates

- Set a real provider API secret in Render and verify image edits with consented test photos. Never commit it or send it in chat.
- Replace `web/privacy.html` draft text with the responsible operator's actual contact and jurisdiction-specific privacy disclosures. Public app launch is blocked until this and provider data-retention review are complete.
- Configure the production Render URL in the release AAB build. A bundle built with no API URL cannot generate hairstyle previews.
- Add durable authentication/quotas and cost/abuse controls before promoting the public image-generation endpoint.
- Create the Play Console account/listing and supply/securely configure an upload key. Store submission and website hosting require owner accounts and cannot be completed from this repository alone.
