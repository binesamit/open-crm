---
title: "Password and two-factor authentication"
slug: personal-security
locale: en
translation_of: personal-security
category: "getting-started"
tags: ["security", "profile", "account"]
visibility: public
excerpt: "Create or change a password, turn on two-factor authentication with an authenticator app on your phone, and keep backup codes in case your phone isn't available."
publish: true
---
The information in the system (clients, deals, documents) deserves good protection. On the **Sign-in & security** tab of your profile page you control the two layers of protection for your user: your password, and two-factor authentication, which adds a code from your phone to every sign-in. That way, even someone who got hold of your password or access to your email can't sign in without your phone.

## What you'll learn

- How to create a password (if until now you signed in with a link or with Google)
- How to change an existing password
- How to turn on two-factor authentication and keep backup codes
- How to sign in with a code, and what to do if you lose your phone

## Getting to the settings

1. Click your avatar at the bottom of the sidebar and choose **My profile**.
2. Go to the **Sign-in & security** tab.

## Creating a password

If until now you've signed in only with an email link or with Google, you'll see the **Create a password** section. A password lets you sign in even when the email doesn't arrive.

1. Type a **New password** (at least 10 characters) and type it again in **Confirm password**.
2. Click **Save password**. From now on you can also sign in with email and password.

## Changing your password

If you already have a password, you'll see the **Change password** section:

1. Type your **Current password**.
2. Type a **New password** and **Confirm password**.
3. Click **Change password**.

> **Note:** After you change your password, all your other sessions (other devices and browsers) are signed out, and you'll need to sign in on them again. This is on purpose: if you were worried someone got your password, they're signed out right away.

## Turning on two-factor authentication

You'll need an authenticator app on your phone, for example Google Authenticator, Microsoft Authenticator or 1Password.

1. In the **Two-factor authentication** section (its status shows as **Off**), click **Turn on two-factor authentication**.
2. If you have a password, type your **Current password (to confirm)** and click **Start**.
3. Open the authenticator app on your phone and scan the QR code on the screen. If you can't scan it, use the key shown under **Can't scan? Key to type in:**.
4. Type the **6-digit code** shown in the app and click **Confirm and turn on**.

![Turning on two-factor authentication: a QR code to scan and a field for the 6-digit code](images/personal-security-1.webp)

### Backup codes

Right after you turn it on, **backup codes** are shown. Each code lets you sign in once, in case your phone isn't available.

1. Click **Copy** or **Save as a file**, and keep the codes somewhere safe (for example in a password manager).
2. Click **I saved them**.

> **Note:** The codes are shown only once. If you lose them, you can generate a new set at any time, and the previous set stops working.

## Signing in with two-factor authentication

From now on, after your password, the email link or Google, you'll see the **Two-factor authentication** screen:

1. Type the 6-digit code from the app.
2. If you're on a regular, secure computer, tick **Remember this device for 30 days** so you aren't asked for a code every time you sign in from it.
3. Click **Sign in**.

Don't have your phone? Click **No phone — use a backup code** and type one of your backup codes. To go back to the code from the app, click **Back to the app code**.

![The code screen at sign-in, with the option to remember the device and use a backup code](images/personal-security-2.webp)

> **Tip:** The code screen is valid for about 10 minutes. If too much time has passed or there were too many attempts, click **Start over** and sign in again.

## Managing and turning off

When two-factor authentication is on (status **Active**), you can:

- Generate **New backup codes**.
- Click **Turn off two-factor authentication**. After you confirm, signing in is once again with a password or link only.

For both actions you first need to type your current password in the **Current password — for two-factor changes** field (if you have a password).

## When the account requires two-factor authentication

The account admin can make two-factor authentication mandatory, for admins only or for all users. In that case:

- If a grace period was set, a banner appears with the last date to turn it on and a **Turn on** button.
- After that date, the next time you sign in you'll see the **Two-factor authentication required** screen, and you'll be asked to turn it on before you continue.
- As long as the account requires it, the button to turn it off isn't available.

## Frequently asked questions

**I lost my phone and my backup codes too. What do I do?**\
Contact your account admin. Admins can **Reset two-factor authentication** for a user from user management; after the reset you sign in without a code and can turn it on again with your new phone.

**I forgot my password and I don't get a reset email.**\
Your account admin can give you a one-time sign-in link. If your account is also connected to Google, you can sign in with it.

**Does a device I chose to remember help on another device?**\
No. "Remember this device" applies only to the device and browser where you ticked the option.

## See also

- Signing in and switching accounts
- My profile and display settings
- Account security
- Managing users and invitations
