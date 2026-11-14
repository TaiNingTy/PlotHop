# PlotHop · Miami and Miami Beach

PlotHop is an interactive transit site exploration prototype. Move the search circle, review resident and job estimates, select a candidate parcel, and switch between Walk Coverage and Station Fit.

## Demo video

[Watch the 60-second walkthrough](https://tainingty.github.io/PlotHop/PlotHop_60s_EN_Captioned.mp4) with English captions and no voiceover.

## Run locally

```sh
python3 -m http.server 8894 --bind 127.0.0.1
```

Open [http://127.0.0.1:8894/](http://127.0.0.1:8894/). For GitHub Pages, serve the repository root. All page assets use relative paths.

## Data and methodology

- [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Pedestrian data are extracted, clipped and transformed into the walk-network model.
- U.S. Census Bureau, [2024 TIGER/Line](https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html), [2020–2024 ACS B01003](https://data.census.gov/table/ACSDT5Y2024.B01003) and [2023 LODES WAC](https://lehd.ces.census.gov/data/). Geometry and statistical records are clipped or transformed for the map and estimates.
- [Miami-Dade GIS](https://www.miamidade.gov/global/service.page?Mduid_service=ser1468850841882434), including parcel, building and pedestrian assets. [Miami-Dade TPO](https://www.miamidadetpo.org/library/studies/little-havana-bicycle-pedestrian-mobility-plan-2016-06.pdf#page=118) for historical pedestrian counts.

Site records use release-specific identifiers. Parcel shapes and modeled access locations retain real geography. Station Fit and Walk Coverage are planning estimates. Entrance, actual passenger counts and engineering feasibility require verification.
