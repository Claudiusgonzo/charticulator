// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.
import * as React from "react";
import * as ReactDOM from "react-dom";

import { MainView } from "./main_view";
import { AppStore } from "./stores";

import {
  initialize,
  Dispatcher,
  Specification,
  Dataset,
  deepClone
} from "../core";
import { ExtensionContext, Extension } from "./extension";
import { Action } from "./actions/actions";

import { CharticulatorWorker } from "../worker";
import { CharticulatorAppConfig } from "./config";

import { ExportTemplateTarget } from "./template";
import { parseHashString } from "./utils";
import { Actions } from "./actions";
import { DatasetSourceSpecification } from "../core/dataset/loader";
import { TableType } from "../core/dataset";
import { LocaleFileFormat } from "../core/dataset/dsv_parser";

function makeDefaultDataset(): Dataset.Dataset {
  const rows: any[] = [];
  const months = "Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec".split(",");
  let monthIndex = 0;
  for (const month of months) {
    let cityIndex = 0;
    for (const city of ["City1", "City2", "City3"]) {
      const value =
        50 +
        30 *
          Math.sin(
            ((monthIndex + 0.5) * Math.PI) / 12 + (cityIndex * Math.PI) / 2
          );
      rows.push({
        _id: "ID" + rows.length,
        Month: month,
        City: city,
        Value: +value.toFixed(1)
      });
      cityIndex += 1;
    }
    monthIndex += 1;
  }
  return {
    tables: [
      {
        name: "Temperature",
        displayName: "Temperature",
        columns: [
          {
            name: "Month",
            displayName: "Month",
            type: Dataset.DataType.String,
            metadata: {
              kind: Dataset.DataKind.Categorical,
              order: months
            }
          },
          {
            name: "City",
            displayName: "City",
            type: Dataset.DataType.String,
            metadata: { kind: Dataset.DataKind.Categorical }
          },
          {
            name: "Value",
            displayName: "Value",
            type: Dataset.DataType.Number,
            metadata: { kind: Dataset.DataKind.Numerical, format: ".1f" }
          }
        ],
        rows,
        type: TableType.Main
      }
    ],
    name: "demo"
  };
}

export class ApplicationExtensionContext implements ExtensionContext {
  constructor(public app: Application) {}

  public getGlobalDispatcher(): Dispatcher<Action> {
    return this.app.appStore.dispatcher;
  }

  /** Get the store */
  public getAppStore(): AppStore {
    return this.app.appStore;
  }

  public getApplication(): Application {
    return this.app;
  }
}

export class Application {
  public worker: CharticulatorWorker;
  public appStore: AppStore;
  public mainView: MainView;
  public extensionContext: ApplicationExtensionContext;

  private config: CharticulatorAppConfig;

  public async initialize(
    config: CharticulatorAppConfig,
    containerID: string,
    workerScriptURL: string
  ) {
    this.config = config;
    await initialize(config);

    const responce = await fetch(`${workerScriptURL}`);
    if (!responce.ok) {
      throw Error(`Loading worker script from ${workerScriptURL} failed`);
    }
    const script = await responce.text();
    const blob = new Blob([script], { type: "application/javascript" });
    const workerScript = URL.createObjectURL(blob);

    this.worker = new CharticulatorWorker(workerScript);
    await this.worker.initialize(config);

    this.appStore = new AppStore(this.worker, makeDefaultDataset());
    (window as any).mainStore = this.appStore;
    ReactDOM.render(
      <MainView store={this.appStore} ref={e => (this.mainView = e)} />,
      document.getElementById(containerID)
    );

    this.extensionContext = new ApplicationExtensionContext(this);

    // Load extensions if any
    if (config.Extensions) {
      config.Extensions.forEach(ext => {
        const scriptTag = document.createElement("script");
        if (typeof ext.script == "string") {
          scriptTag.src = ext.script;
        } else {
          scriptTag.integrity = ext.script.integrity;
          scriptTag.src = ext.script.src + "?sha256=" + ext.script.sha256;
        }
        scriptTag.onload = () => {
          // tslint:disable-next-line no-eval
          eval(
            "(function() { return function(application) { " +
              ext.initialize +
              " } })()"
          )(this);
        };
        document.body.appendChild(scriptTag);
      });
    }

    await this.processHashString();
  }

  public setupNestedEditor(id: string) {
    window.addEventListener("message", (e: MessageEvent) => {
      if (e.data.id != id) {
        return;
      }
      const info: {
        dataset: Dataset.Dataset;
        specification: Specification.Chart;
        width: number;
        height: number;
        filterCondition: {
          column: string;
          value: any;
        };
      } = e.data;
      info.specification.mappings.width = {
        type: "value",
        value: info.width
      } as Specification.ValueMapping;
      info.specification.mappings.height = {
        type: "value",
        value: info.height
      } as Specification.ValueMapping;
      this.appStore.dispatcher.dispatch(
        new Actions.ImportChartAndDataset(info.specification, info.dataset, {
          filterCondition: info.filterCondition
        })
      );
      this.appStore.setupNestedEditor(newSpecification => {
        const template = deepClone(this.appStore.buildChartTemplate());
        if (window.opener) {
          window.opener.postMessage(
            {
              id,
              type: "save",
              specification: newSpecification,
              template
            },
            document.location.origin
          );
        } else {
          if (this.config.CorsPolicy && this.config.CorsPolicy.TargetOrigins) {
            window.parent.postMessage(
              {
                id,
                type: "save",
                specification: newSpecification,
                template
              },
              this.config.CorsPolicy.TargetOrigins
            );
          }
        }
      });
    });
    if (window.opener) {
      window.opener.postMessage(
        {
          id,
          type: "initialized"
        },
        document.location.origin
      );
    } else {
      if (this.config.CorsPolicy && this.config.CorsPolicy.TargetOrigins) {
        window.parent.postMessage(
          {
            id,
            type: "initialized"
          },
          this.config.CorsPolicy.TargetOrigins
        );
      }
    }
  }

  public async processHashString() {
    // Load saved state or data from hash
    const hashParsed = parseHashString(document.location.hash);

    if (hashParsed.nestedEditor) {
      document.title = "Nested Chart | Charticulator";
      this.setupNestedEditor(hashParsed.nestedEditor);
    } else if (hashParsed.loadDataset) {
      // Load from a dataset specification json format
      const spec: DatasetSourceSpecification = JSON.parse(hashParsed.dataset);
      const loader = new Dataset.DatasetLoader();
      const dataset = await loader.loadDatasetFromSourceSpecification(spec);
      this.appStore.dispatcher.dispatch(new Actions.ImportDataset(dataset));
    } else if (hashParsed.loadCSV) {
      // Quick load from one or two CSV files
      // default to comma delimiter, and en-US number format
      const localeFileFormat: LocaleFileFormat = {
        delimiter: ",",
        numberFormat: {
          remove: ",",
          decimal: "."
        }
      };
      const spec: DatasetSourceSpecification = {
        tables: hashParsed.loadCSV
          .split("|")
          .map(x => ({ url: x, localeFileFormat }))
      };
      const loader = new Dataset.DatasetLoader();
      const dataset = await loader.loadDatasetFromSourceSpecification(spec);
      this.appStore.dispatcher.dispatch(new Actions.ImportDataset(dataset));
    } else if (hashParsed.load) {
      // Load a saved state
      const value = await fetch(hashParsed.load);
      const json = await value.json();
      this.appStore.dispatcher.dispatch(new Actions.Load(json.state));
    } else {
      this.mainView.refMenuBar.showFileModalWindow("new");
    }
  }

  public addExtension(extension: Extension) {
    extension.activate(this.extensionContext);
  }

  public registerExportTemplateTarget(
    name: string,
    ctor: (
      template: Specification.Template.ChartTemplate
    ) => ExportTemplateTarget
  ) {
    this.appStore.registerExportTemplateTarget(name, ctor);
  }

  public unregisterExportTemplateTarget(name: string) {
    this.appStore.unregisterExportTemplateTarget(name);
  }
}
