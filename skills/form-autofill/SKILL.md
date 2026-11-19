---
name: "form-autofill"
title: "Intelligent Form Autofill"
description: "Detect and sequentially fill multi-field forms, checkouts, and applications with semantic field grounding."
trigger: "/autofill"
tags: [forms, automation, inputs]
author: "user"
isBuiltin: true
icon: "edit"
---

# Intelligent Form Autofill Instructions
When autofilling forms or multi-step checkout dialogs:
1. MAP ALL FIELDS: Inspect labels, placeholders, input types, and aria-attributes across standard DOM and Shadow DOM.
2. SEQUENTIAL DISPATCH: Emit INPUT_TEXT actions field-by-field. Never skip required fields.
3. CONTROLLED COMPONENT RESPECT: Dispatch real hardware keystrokes and change events so framework state machines update.
4. NO BLIND SUBMISSION: Never click the final submit/purchase button if required fields are still empty or validation errors show.
