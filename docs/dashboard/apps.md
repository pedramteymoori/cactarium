# Apps

The **Apps** tab, `/?tab=apps`, lists the apps on the launcher's row, each with its icon and a **Launch** button. The row is edited on the [Home tab](home.md).

<!-- Screenshot to come: the Apps tab. -->

Launch opens the app on the TV through the PHI bridge (`POST /api/tv/phi`, method `launch`, with the app's entry from `GET /api/launcher/apps`). PHI is frozen while a web app runs, so while one is open the tab says it is not available. If the row is empty, the launcher shows the TV's own app list and this tab has nothing to list.

Installing, removing and keeping apps in the background are not offered: TitanOS apps come from the TitanOS catalog.
