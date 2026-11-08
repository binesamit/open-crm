---
title: "The formula column"
slug: formula-column
locale: en
translation_of: formula-column
category: "columns"
tags: ["columns", "boards"]
visibility: public
excerpt: "How to build a formula column that calculates values from other columns: writing the formula, picking columns and functions, formatting the result and useful examples."
publish: true
---
A **Formula** column calculates a value for each item from other columns in the same row, much like a formula in a spreadsheet. You can use it to calculate a total including VAT, the days left until a due date, a health score for a project, or text combined from several fields. The result updates on its own whenever one of the columns the formula reads changes, and you can filter, sort and summarize by it like any other column.

## What you'll learn

- How to create a formula column and write your first formula
- How to insert columns and functions into a formula without remembering syntax
- How to format a numeric result and show a result as a link
- Examples of common formulas

## Creating a formula column

1. Click **+** (**Add column**) at the end of the header row and choose **Formula**.
2. In the column menu (**⋯** in the header), choose **Column settings**.
3. Write the formula in the **Formula** field and click **Save**.

## Writing the formula

Columns appear in a formula inside curly braces, by their ID, for example `{price}`. You don't need to remember IDs. There are three convenient ways to insert a column or function:

- **Type** `{`: a list of suggestions for **Columns and functions** opens. Keep typing to narrow it down and pick from the list.
- **The column list**: under the field there's a **Columns** row with all the board's columns. Clicking a column inserts it at the cursor.
- **The function list**: the lower part of the window shows all the functions, split into categories: **All**, **Logic**, **Numbers**, **Text** and **Dates**. For each function you see its syntax, a short explanation and an example with its result. You can search in the **Search functions** field, and clicking a function inserts it with the cursor inside the parentheses.

![The formula settings window with the formula field, the column list and the function list](images/formula-column-1.webp)

If there's an error in the formula (a missing parenthesis, an unknown function name or a column that doesn't exist), a red message appears under the field, and the **Save** button stays unavailable until you fix it.

## Available functions

There are about 50 functions, including:

| Category | Examples |
| --- | --- |
| **Logic** | IF, AND, OR, NOT, SWITCH, IFERROR, ISBLANK |
| **Numbers** | SUM, AVERAGE, MIN, MAX, COUNT, ROUND, ROUNDUP, ROUNDDOWN, ABS, MOD, DIVIDE, MULTIPLY, MINUS, POWER, SQRT |
| **Text** | CONCATENATE, LEN, LEFT, RIGHT, TRIM, UPPER, LOWER, REPLACE, SUBSTITUTE, SEARCH, REPT, TEXT, VALUE |
| **Dates** | TODAY, NOW, DATE, DAYS, WORKDAYS, HOURS\_DIFF, ADD\_DAYS, SUBTRACT\_DAYS, FORMAT\_DATE, YEAR, MONTH, DAY, WEEKNUM, HOUR, MINUTE |

You can also use ordinary arithmetic (+ − \* /), comparisons (\> \< =) and join text with &.

## Useful examples

- **Price including VAT:** `ROUND({price}*1.18,2)`
- **Days until the due date:** `DAYS({due_date},TODAY())`
- **Workdays in a project** (excluding Friday and Saturday): `WORKDAYS({end},{start})`
- **Flagging an overrun:** `IF({actual}>{budget},"Over budget","On budget")`
- **Full name:** `CONCATENATE({first_name}," ",{last_name})`
- **Guarding against division by zero:** `IFERROR(DIVIDE({revenue},{units}),0)`

> **Tip:** The names in braces in these examples are for illustration. On your board, pick the columns from the list so the right ID is inserted automatically. You can also see any column's ID with **Copy column ID** in the column menu.

## Formatting the result

### Displaying a numeric result

When the formula returns a number, you can display it as in a numbers column: currency, percent or a custom unit, the number of decimal places, and a thousands separator. The setting also applies in the summary row, in mirror columns and in exports.

### Showing as a link

When the result is a web address, under **Show as link** choose:

- **Automatic**: an address that starts with https:// is shown as a clickable link.
- **Always (also without https://)**: even a bare domain, like example.co.il, becomes a link.
- **Never**: the result is shown as plain text.

Links open in a new tab, and only http and https addresses are shown as links, for security reasons.

![A formula result shown as a clickable link in the table](images/formula-column-2.webp)

## Frequently asked questions

**Can I manually edit the value shown in a formula column?**\
No. The value is always calculated from the formula. To change it, change the formula or the values in the columns it reads.

**What happens to the formula if I change the type of a column it uses?**\
The formula keeps working with the value in the new type. If a function no longer fits, the cell shows an error. The conversion preview warns you in advance.

**How do I summarize data from another board?**\
A formula reads columns of the same item. To bring in values from another board, use connect boards and a mirror column, and then you can use the mirror column in the formula too.

## See also

- Numbers, rating, progress tracking, checkbox and vote
- Connect boards and the mirror column
- Adding and managing columns
- Converting a column's type
- The AI column
