---
title: "Map view"
slug: map-view
locale: en
translation_of: map-view
category: "views"
tags: ["views", "columns", "admin"]
visibility: public
excerpt: "Place the board's items on a map by a location column, color markers by status and open any item straight from the map."
publish: true
---
The map view shows every item as a marker on a map, based on the address in its **Location** column. It's especially useful for branches, customers in the field, properties, work sites and deliveries: anywhere "where" matters as much as "what". Markers are colored by status and grouped automatically when they're close to each other.

## What you'll learn

- What the board needs to show a map
- How to work with the markers, the list and the side card
- How to choose a marker color and the fields on the card
- What happens with addresses that haven't been located yet

## Before you start: a location column

The map is based on a column of type **Location**. When you type an address in such a column, the system automatically finds its coordinates, and the item appears on the map.

> **Note:** If the board has no location column, you'll see the message **This board has no location column** with the hint **Add a "Location" column and fill in addresses — the items appear on the map.**

## Creating a map view

1. At the top of the board, click **+** next to the view tabs.
2. Choose **Map**, give it a name and click **OK**.
3. The map loads with a marker for every item that has a located address.

![A map view with colored markers, a cluster with a number, and the item list on the side](images/map-view-1.webp)

## Working with the map

- **Zoom and drag:** use the mouse wheel or the zoom buttons, and drag the map to move around.
- **Clusters:** nearby markers merge into a circle with a number. Zoom in (or click the cluster) to break it up.
- **Selecting an item:** click a marker and the item's card appears on the side, with the fields you chose. As long as no item is selected, it shows **Click a marker to see the item**.
- **Opening the item:** click the side card to open the full item card.

### The side list

Below the card is a count such as **12 items on the map**, and a list of all the items with their addresses. Clicking an item in the list focuses on it on the map, which is especially handy when markers are crowded and clustered.

### Addresses not on the map yet

A message appears in the corner of the map when there are addresses that aren't shown:

- **3 addresses waiting to be located**: the address was received and locating is still running; the item will appear in a moment.
- **2 addresses not found**: the address couldn't be located. It's worth fixing it in the location column (for example, adding a city).

## Map settings

In the toolbar, click **View settings**:

| Setting | What it does |
| --- | --- |
| **Location column** | When there are several location columns, which one to use |
| **Marker colour by** | A status column whose colors paint the markers, or **One colour** |
| **Fields on the card** | Which columns are shown on the card that opens when you click a marker |

![The map's "View settings" window with "Location column", "Marker colour by" and "Fields on the card"](images/map-view-2.webp)

Here too, the search, the **Filter** and the **Person** filter apply to the map: only items that match the filter are shown. Save the settings with **Save to view**.

> **Tip:** Create several map views with different filters, for example "Active customers" and "Open requests", to plan field work routes.

## Account map settings (for admins)

Account admins can change the map provider and how addresses are located in the **Admin center** → **Connections**, on the **Maps and addresses** card:

- **Map style URL (MapLibre style)**: empty = the free default (OpenFreeMap). You can switch to another provider.
- **Extra domains the map loads from**: needed when you switch to another provider.
- **Locate addresses on the map**: **On** or **Off**.
- **Address completion while typing**: **Automatic**, **Photon**, **Google** or **Off**.
- **Google Maps key (optional)**: for locating and completing addresses through Google. The key is stored encrypted and isn't shown again.

## Frequently asked questions

**An item with an address doesn't appear on the map.**\
Check that the address in the location column is complete and accurate, and make sure no filter is hiding the item.

**Can I change an address directly from the map?**\
You edit the address in the location column, in the table or in the item card. The map updates right away.

**Does the map cost money?**\
The default is free and doesn't need a key. A Google key is optional only.

## See also

- Email, phone, link, location and country
- Working with views
- The admin center
- Calendar view
