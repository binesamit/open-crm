---
title: "AI column"
slug: ai-column
locale: en
translation_of: ai-column
category: "ai-and-agents"
tags: ["ai", "columns"]
visibility: public
excerpt: "How to add an AI column that summarizes, classifies, extracts, translates or creates an image — and how to run it on one cell or the whole board."
publish: true
---
An AI column fills itself in using artificial intelligence: it reads other columns of the item — and, if you like, its updates too — and returns a result into the cell. This way you can, for example, summarize each customer request in one line, classify leads as "hot" and "cold", extract a phone number from free text, or translate a description into English — without copying and pasting anything yourself.

## What you'll learn

- How to add an AI column and choose what it does
- Which columns the AI reads and how to write a prompt
- How to run the column on a cell, on selected items or on the whole board
- How to control costs with caps
- What you see in a cell created by AI

> **Note:** For an AI column to work, the account admin needs to turn on AI and add at least one AI connection. If there's no connection yet, the column settings show the message **The account has no AI connection yet — an admin adds one in the settings.**

## Adding an AI column

1. In the board's table header, click **Add column** and choose the **AI** type.
2. To open the settings of an existing column, click the column header (or right-click it) and choose **Column settings**.
3. Choose the **Output**: **Text** (the result is written into the cell) or **Image** (saved as a file in a files column).
4. Under **What the column does**, choose one of the options:

| Type | What it does |
| --- | --- |
| **Summarize** | Summarizes the information in the item. You choose the **Summary length**: **Short**, **Medium** or **Long**. |
| **Classify** | Picks one label from a list. Under **Labels from**, choose **A fixed list** (one label per line) or an existing status / dropdown column. |
| **Extract** | Pulls out a specific value: **Text**, **Number**, **Date**, **Email** or **Phone**. |
| **Translate** | Translates into the **Target language** you choose. |
| **Custom prompt** | You write the **Prompt** in your own words. |

1. Under **AI connection**, choose the connection, and under **Model** — a specific model or **The connection's default**.
2. Click **Save**.

![AI column settings window with the action types, the connection and the columns the AI reads](images/ai-column-1.webp)

## What the AI reads, and how to write a prompt

In the **What the AI reads** section, tick which columns are sent to the AI: the **Item name**, other columns, and, if you want, **The item's latest updates**.

- Only columns that the person running the column is allowed to see are sent.
- In the prompt you can mention a column in curly braces, for example {Status}. A column mentioned this way is added to the list automatically.
- With classification you can choose **Also write the label to** a column — the same label is also written into a status or dropdown column, in the same action, and that can be undone too.

> **Tip:** A good prompt is short and unambiguous. For example: "Summarize the customer's request in one sentence, and say whether there's a deadline."

## An AI column that creates images

When you choose an **Output** of type **Image**, you need to choose a **File column for the image** — that's where the image is saved, and the AI cell shows the file name. Write an **Image description**, and you can set the **Size** and **Quality** or leave the **Account default**. If the board has no files column, add one first.

## Running the column

There are several ways to run the AI:

1. **On one cell:** In an empty cell, click the small run button (**Run AI**). In a cell that's already filled, hover over it and the button appears as **Run again**.
2. **On selected items:** Select several items, and in the action bar that opens at the bottom, click **AI** and choose the column.
3. **On the whole board:** In the column header menu, or at the bottom of the settings window, choose **Run on empty cells** or **Run on all cells**.
4. **Automatically:** Tick **Run by itself when its input columns change** in the settings, and the cell updates whenever the information it relies on changes.

When each run finishes, a message such as "AI filled 12 cells" appears, with the cost and an **Undo** button that reverts the whole run.

![The action bar with the AI button for running on selected items](images/ai-column-2.webp)

## What you see in the cell

A cell filled by AI is marked with a small icon. Hovering over it shows **Created by AI** along with the model, cost and time. Clicking the cell opens the full text, where you can choose:

- **Run again** — get a new result.
- **Edit by hand** — fix the text yourself. The cell is marked **Written by hand**.
- **Clear** — empty the cell.

## Controlling costs

The column settings have three caps:

- **Items per run** — the maximum number of items in one run.
- **Max $ per run** — the run stops when it reaches this amount.
- **Max $ per month** — how much the column may spend in a month. **None** = no cap. Below it you see how much has already been spent this month.

On top of that, the account's monthly budget applies, which the account admin sets.

## Frequently asked questions

**The run failed with "The answer wasn't one of the labels". What should I do?**\
With classification, the model must pick a label from the list. Word the labels more clearly or add an explanation in the additional instructions.

**Who can run an AI column?**\
Anyone allowed to edit items on the board.

**Does the AI see information I don't have access to?**\
No. Only columns that the person running it is allowed to see are sent.

## See also

- Adding and managing columns
- The AI assistant
- Setting up AI for the account
- Multi-select and actions on several items
- Files column
