---
title: "Duplicating a board, templates and boards from a template"
slug: board-templates
locale: en
translation_of: board-templates
category: "boards-groups-and-items"
tags: ["boards", "workspace", "admin"]
visibility: public
excerpt: "How to duplicate an existing board, save a board as a template, create a new board from a template and manage the account's template library."
publish: true
---
Once you've built a board that works well, with the right columns, groups and settings, there's no reason to build it again from scratch. You can duplicate it once, for example for another project, or save it as a template that anyone in the account can use to create a new board in a few clicks. This article covers both ways and how to manage templates.

## What you'll learn

- Duplicate a board, with or without items
- Save a board as a template, with or without the items
- Create a new board from a template
- Edit, duplicate and delete templates from the admin page

## Duplicating a board

1. In the sidebar, hover over the board name and click **⋯** (or right-click the board).
2. Choose **Duplicate board**.
3. In the window that opens:

   - **New board name**: "Copy of …" is suggested. You can change it.
   - **What to copy**: **Structure only** (columns, groups, shared views and permissions, without items), **Structure and items**, or **Structure, items and updates**.
   - **Workspace**: If you have more than one workspace, you can create the copy in a different workspace.
   - **Keep the subscribers**: Tick this so the original board's members are also subscribed to the copy.
4. Click **Duplicate**. The new board opens right away.

![Duplicate board window with the choice of what to copy](images/board-templates-1.webp)

> **Tip:** **Structure only** suits when you want "the same board, a clean slate", for example for the next quarter. **Structure and items** suits when you want to carry on from the same point on a separate board.

## Saving a board as a template

1. In the sidebar, open the board's menu (**⋯**) and choose **Save as template**.
2. In the window:

   - **Save to**: **New template**, or replace an existing template (**Replace "…"**).
   - **Template name**: the name that appears in the template list.
   - **With the items (up to 500, with values and subitems)**: Tick this if you want a board created from the template to start with this board's items, for example a fixed task list.
3. Click **Save**. A message appears saying the template was saved and is available under "New board".

> **Note:** The **Save as template** option appears for people who are allowed to edit the board.

## Creating a board from a template

There are two ways:

**From the add menu:**

1. In the sidebar, click **+** (**Add new**) and choose **Board from a template**.
2. In the window, choose a **Template**, type the **Board name**, and choose a **Folder** and **Type** if needed.
3. Click **Create board**.

**From the new board window:**\
The **New board** window has a **Template** field. The default is **Empty board**, and you can pick any template from the list.

![Board from a template window with the template list open](images/board-templates-2.webp)

The new board gets the template's structure: columns with their settings, groups, subitem columns and permissions. If the template was saved with items, they're created too. Boards already created from a template don't change when the template is updated later.

## Managing the account's templates

The list of all templates is on the **Administration** page, in the **Templates** section. The page is available to account admins. The list shows the built-in templates (marked **Built-in**) and the templates you've saved, and next to each one what it includes: **Structure only** or **Structure and N items**.

Click **⋯** in the template's row to choose:

| Action | What it does |
| --- | --- |
| **Edit template** | Opens a temporary working board built from the template, so you can change it |
| **Rename** | Changes the template's name |
| **Edit description** | Adds a short description shown under the name |
| **Duplicate** | Creates a copy of the template, "(copy)" |
| **Delete** | Deletes the template. A built-in template is only removed from your account |

### Editing a template

1. Choose **Edit template**. A temporary working board opens, with a bar at the top: **Editing the template "…"**. This board doesn't appear in the board list.
2. Change what you need: columns, groups, items.
3. Click **Save to template**, and in the window that opens choose whether to include the items. The template is updated, and the working board is removed.

Want to stop halfway? **Back to templates** keeps the working board as a draft. In the list, **Open draft** appears next to the template, and **Continue editing** takes you back to it. **Cancel editing** deletes the draft, and the template stays as it was.

### Removed built-in templates

A built-in template you deleted doesn't disappear completely. At the bottom of the list there's **Removed built-in templates**, and from there you can bring it back by clicking **Restore**.

## Frequently asked questions

**What's the difference between duplicating a board and a template?**\
Duplicating creates one new board, now. A template is saved for reuse, and anyone in the account can create new boards from it whenever they need.

**What isn't copied when duplicating?**\
Private views, webhooks and the activity history aren't copied, and the board's automations don't carry over either. After duplicating, open **Automations** on the new board and add what you need.

**I changed a template. Will the boards created from it change?**\
No. A template is only a starting point. The change affects only boards created from it from now on.

## See also

- Creating your first board
- Workspaces and folders
- The admin center
- Introduction to automations and templates
