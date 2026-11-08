---
title: "Numbers, rating, progress tracking, checkbox and vote"
slug: numbers-columns
locale: en
translation_of: numbers-columns
category: "columns"
tags: ["columns", "subitems", "boards"]
visibility: public
excerpt: "How to work with numbers columns (including currency, percent and the summary row), star ratings, calculated progress tracking, checkbox and vote."
publish: true
---
The columns in this article turn your board into a measuring tool: how much each deal is worth, how much of the work is done, how a supplier is rated, which tasks are checked off and what the team wants most. Each of them also has a ready-made calculation in the summary row at the bottom of every group, so you see sums, averages and percentages without building a formula.

## What you'll learn

- How to set up a numbers column with currency, percent or your own unit
- How to choose a calculation in the summary row
- How to use rating, checkbox and vote
- How to set up a progress tracking column calculated from statuses and subitems

## Numbers column

Click a cell in the column, type a number and press Enter. You can also paste values such as "1,250 ₪". The app strips the symbols and saves the number.

### Number format

1. In the column menu (**⋯** in the header), choose **Column settings**.
2. Under **Number format**, choose:

   - **Plain number**
   - **Currency** – choose the **Currency** (₪, $, €, £ or ¥). The default is the currency set for the account.
   - **Percent**
   - **Custom unit** – type a **Unit (up to 8 characters)**, for example "kg" or "hours".
3. For currency and a custom unit, you can set the **Symbol position**: **Before the number** or **After the number**.
4. In **Decimal places**, choose a fixed number or **Automatic**.
5. Check **Thousands separator (1,000)** to show 12,500 instead of 12500.
6. Check the **Preview** and click **Save**.

![Numbers column settings with a currency choice, decimal places and a preview](images/numbers-columns-1.webp)

> **Tip:** The format affects only how the number looks. The saved value is the number itself, so formulas, sorting and filters such as **greater than** work on it as usual.

## The summary row

At the bottom of every group there is a summary row. Click a column's cell in this row (**Summary calculation**) and choose the calculation:

| Column | Possible calculations |
| --- | --- |
| Numbers, rating, vote, progress tracking | **Sum**, **Average**, **Median**, **Minimum**, **Maximum**, **Count**, **None** |
| Checkbox | **checked** (how many out of how many), **None** |
| Status | **distribution** (a color bar), **filled**, **None** |

## Rating column

The **Rating** column shows five stars. Click the star you want to rate, and click the same star again to clear the rating. In the summary row the default is **Average**, so you immediately see the group's average rating.

> **Note:** When you convert a numbers column to a rating column, you can choose a scale of 3, 4, 5 or 10 stars.

## Checkbox

Clicking the cell checks or unchecks it. A checkbox suits yes/no questions, such as "Invoice sent" or "Approved by the client". The summary row shows how many items in the group are checked.

## Vote column

The **Vote** column lets each user vote once on each item, for example to pick ideas to develop or to prioritize client requests.

1. Click the **Vote** button (the thumbs-up) in the cell. The number goes up by one.
2. To cancel, click it again (**Take back my vote**).
3. Hovering over the number shows who voted.

Sorting by the vote column brings the most popular items to the top of the board.

## Progress tracking column

The **Progress tracking** column shows a bar with the completion percentage on every item. It is calculated automatically and you can't type in it. Before it starts working, you need to set what it is calculated from. Until then, the cell shows **Not set up**.

1. Open **Column settings**.
2. Under **Compute from**, choose:

   - **Subitems** – the percentage is how many of the subitems are in a label that counts as "done".
   - **Status columns of the item** – each status column you check is a stage, with its own **Weight**.
   - **Both** – a combination, with the **Weight of the subitems against the status columns**.
3. When calculating from subitems, choose **The subitems' status column** and the **Labels that count as done** (click a label to check or uncheck it).
4. More options:

   - **Include sub-subitems** – a subitem that has subitems of its own counts by their progress, at any depth.
   - **Weight of each subitem** – by a numbers column (for example estimated hours), or **All equal**.
   - **Hide the percentage next to the bar**.
5. At the bottom of the window there is a plain-words explanation of what you set up, for example "the percentage of subitems whose status is Done". If something is missing, the window says exactly what (**For the column to work, it still needs:**).
6. Click **Save**.

![Progress tracking column settings with the calculation source and the done labels](images/numbers-columns-2.webp)

## FAQ

**How do I add up several columns in the same row?**\
Use a formula column, for example SUM of the two numbers columns.

**Can I type a value manually in a progress tracking column?**\
No. The column is always calculated from the statuses and subitems, so the percentage reflects the real state.

**What's the difference between vote and rating?**\
A rating is one shared value for the item that anyone can change. In a vote, each user adds their own vote, and the number is the total of voters.

## See also

- Formula column
- Status, dropdown and tags
- Subitems and depth levels
- Adding and managing columns
- Chart view
