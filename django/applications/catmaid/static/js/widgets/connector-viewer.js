/* -*- mode: espresso; espresso-indent-level: 2; indent-tabs-mode: nil -*- */
/* vim: set softtabstop=2 shiftwidth=2 tabstop=2 expandtab: */

(function(CATMAID) {

  "use strict";

  const CACHE_TIMEOUT = 5*60*1000;

  const DEFAULT_WIDTH = 3;
  const DEFAULT_HEIGHT = 3;
  const MAX_WIDTH = 5;
  const MAX_HEIGHT = 5;

  const DEFAULT_CONNECTOR_RELATION = 'presynaptic_to';

  const HIDER_Z_INDEX = 100;
  const PANEL_PADDING = 1;

  const TRACING_OVERLAY_BUFFER = 64;

  const DEFAULT_SHOW_SCALE_BAR = false;

  const DEFAULT_SORT_FN_TITLE = 'Connector depth (proportion)';

  /**
   * Create a new connector viewer, optional with a set of initial skeleton
   * models.
   */
  var ConnectorViewer = function(skeletonModels)
  {
    this.widgetID = this.registerInstance();
    this.idPrefix = `connector-viewer${this.widgetID}-`;

    // This skeleton source takes care of internal skeleton management. It is
    // not registered. It is the input skeleton sink, but the output is handled
    // with a second source
    var updateWithSkels = this.updateWithSkels.bind(this);
    this.skeletonSource = new CATMAID.BasicSkeletonSource(this.getName() + " Input", {
      register: false,
      handleAddedModels: updateWithSkels,
      handleChangedModels: updateWithSkels,
      handleRemovedModels: updateWithSkels
    });
    // A skeleton source to collect results in
    this.resultSkeletonSource = new CATMAID.BasicSkeletonSource(this.getName());

    this.cache = new ConnectorViewerCache(this.skeletonSource);
    this.currentConnectorOrder = [];
    this.firstConnectorIdx = 0;

    this.currentConnectorRelation = DEFAULT_CONNECTOR_RELATION;
    this.dimensions = [DEFAULT_HEIGHT, DEFAULT_WIDTH];

    this.sourceStackViewer = project.getStackViewers()[0];
    this.stackViewers = [];
    this.panelWindows = [];
    this.showScaleBar = DEFAULT_SHOW_SCALE_BAR;

    if (skeletonModels) {
      this.skeletonSource.append(skeletonModels);
    }
  };

  ConnectorViewer.prototype = {};
  $.extend(ConnectorViewer.prototype, new InstanceRegistry());

  ConnectorViewer.prototype.getName = function() {
    return "Connector Viewer " + this.widgetID;
  };

  ConnectorViewer.prototype.destroy = function() {
    this.closeStackViewers();
    this.unregisterInstance();
  };

  /**
   * Update the text describing which connectors are shown.
   */
  ConnectorViewer.prototype.updateShowingText = function() {
    var total = this.currentConnectorOrder.length;
    var start = Math.min(this.firstConnectorIdx + 1, total);
    var stop = Math.min(this.firstConnectorIdx + this.dimensions[0] * this.dimensions[1], total);

    var showingTextSelector = $(`#${this.idPrefix}showing`);
    showingTextSelector.find(`.start`).text(start);
    showingTextSelector.find(`.stop`).text(stop);
    showingTextSelector.find(`.total`).text(total);
  };

  /**
   *
   * @param newPage zero-indexed
   */
  ConnectorViewer.prototype.changePage = function(newPage) {
    var currentPageElement = document.getElementById(this.idPrefix + 'current-page');

    var total = this.currentConnectorOrder.length;

    if (total === 0) {
      currentPageElement.value = 1;
      this.update();
      return 0;
    }

    var newFirstConnectorIdx = newPage * this.dimensions[0] * this.dimensions[1];

    if (this.firstConnectorIdx === newFirstConnectorIdx) {  // page may not be changing
      this.update();
      return Number(currentPageElement.value) - 1;
    } else if (newPage < 0 || newFirstConnectorIdx >= total) {  // page out of bounds
      alert('This page does not exist! Returning to page 1.');
      return this.changePage(0);
    } else {
      this.firstConnectorIdx = newFirstConnectorIdx;
      currentPageElement.value = newPage + 1;
      this.update();
      return newPage;
    }
  };

  ConnectorViewer.prototype.clearCache = function() {
    this.currentConnectorOrder = [];
    this.firstConnectorIdx = 0;
    this.cache.clear();
  };

  ConnectorViewer.prototype.closeStackViewers = function () {
    for (var stackViewer of this.stackViewers) {
      stackViewer.destroy();
    }
  };

  ConnectorViewer.prototype.getVisibleConnectors = function() {
    var firstConnIdx = this.firstConnectorIdx;

    return this.currentConnectorOrder.slice(
      firstConnIdx,
      firstConnIdx + this.dimensions[0] * this.dimensions[1]
    );
  };

  /**
   * Returns a list of stack windows not inside a connector viewer.
   *
   * @returns {Array} of objects {'title': stackViewerWindowTitle, 'stackViewer': stackViewerInstance}
   */
  ConnectorViewer.prototype.getOtherStackViewerOptions = function () {
    return project.getStackViewers()
      .filter(function(stackViewer) {
        // only stack viewers not living in a connector-viewer panel window
        return !stackViewer.getWindow().frame.classList.contains('connector-panel');
      })
      .map(function(stackViewer) {
        return {
          title: stackViewer.getWindow().title,
          value: stackViewer
        };
      });
  };

  ConnectorViewer.prototype.updateConnectorOrder = function(){
    var self = this;
    return this.cache
      .updateConnectorOrder(self.currentConnectorRelation)
      .then(function(connectorOrder) {
          self.currentConnectorOrder = connectorOrder;
          return connectorOrder;
        });
      };

  ConnectorViewer.prototype.getWidgetConfiguration = function() {
    return {
      helpText: "Connector Viewer widget: Quickly view and compare connectors associated with given skeletons",
      controlsID: this.idPrefix + 'controls',
      createControls: function(controls) {
        var self = this;

        // WIDGET SETTINGS CONTROLS

        var sourceStackViewer = CATMAID.DOM.createSelect(
          self.idPrefix + 'source-stack-viewer',
          self.getOtherStackViewerOptions(),
          this.sourceStackViewer._stackWindow.title
        );
        sourceStackViewer.onchange = function() {
          self.sourceStackViewer = this.value;
          self.redrawPanels();
          self.updateWithSkels();
        };

        var sourceStackViewerLabel = document.createElement('label');
        sourceStackViewerLabel.appendChild(document.createTextNode('Source stack viewer'));
        sourceStackViewerLabel.appendChild(sourceStackViewer);
        controls.appendChild(sourceStackViewerLabel);

        var tileCounts = document.createElement('div');
        tileCounts.style.display = 'inline-block';
        controls.appendChild(tileCounts);

        var makeTileCountOptions = function(max) {
          var arr = [];
          for (var i = 1; i <= max; i++) {
            arr.push({title: i, value:i});
          }
          return arr;
        };

        var hTileCount = CATMAID.DOM.createSelect(
          self.idPrefix + "h-tile-count",
          makeTileCountOptions(MAX_HEIGHT),
          String(DEFAULT_HEIGHT)
        );
        hTileCount.onchange = function() {
          self.redrawPanels();
          self.update();
        };

        var hTileCountLabel = document.createElement('label');
        hTileCountLabel.appendChild(document.createTextNode('Height'));
        hTileCountLabel.appendChild(hTileCount);
        tileCounts.appendChild(hTileCountLabel);

        var wTileCount = CATMAID.DOM.createSelect(
          self.idPrefix + "w-tile-count",
          makeTileCountOptions(MAX_WIDTH),
          String(DEFAULT_WIDTH)
        );
        wTileCount.onchange = function() {
          self.redrawPanels();
          self.update();
        };

        var wTileCountLabel = document.createElement('label');
        wTileCountLabel.appendChild(document.createTextNode('Width'));
        wTileCountLabel.appendChild(wTileCount);
        tileCounts.appendChild(wTileCountLabel);

        var scaleBarCb = document.createElement('input');
        scaleBarCb.setAttribute('type', 'checkbox');
        scaleBarCb.checked = DEFAULT_SHOW_SCALE_BAR;
        scaleBarCb.onchange = function() {
          self.showScaleBar = this.checked;
          for (var stackViewer of self.stackViewers) {
            stackViewer.updateScaleBar(self.showScaleBar);
          }
        };

        var scaleBarCbLabel = document.createElement('label');
        scaleBarCbLabel.appendChild(document.createTextNode('Scale bars'));
        scaleBarCbLabel.appendChild(scaleBarCb);
        controls.appendChild(scaleBarCbLabel);

        controls.appendChild(document.createElement('br'));

        // CONNECTOR SELECTION CONTROLS

        var sourceSelect = CATMAID.skeletonListSources.createSelect(this.skeletonSource);
        controls.appendChild(sourceSelect);

        var add = document.createElement('input');
        add.setAttribute("type", "button");
        add.setAttribute("value", "Add");
        add.onclick = function() {
          self.skeletonSource.loadSource.bind(self.skeletonSource)();
        };
        controls.appendChild(add);

        var clear = document.createElement('input');
        clear.setAttribute("type", "button");
        clear.setAttribute("value", "Clear");
        clear.onclick = function() {
          self.clearCache();
          self.skeletonSource.clear();
        };
        controls.appendChild(clear);

        var refresh = document.createElement('input');
        refresh.setAttribute("type", "button");
        refresh.setAttribute("value", "Refresh");
        refresh.onclick = function() {
          self.clearCache();
          self.redrawPanels();
          self.updateWithSkels();
        };
        controls.appendChild(refresh);

        var relation = CATMAID.DOM.createSelect(
          self.idPrefix + "relation-type",
          [
            {title: 'Incoming connectors', value: "postsynaptic_to"},
            {title: 'Outgoing connectors', value: "presynaptic_to"},
            {title: 'Gap junction connectors', value: "gapjunction_with"},
            {title: 'Abutting connectors', value: "abutting"}
          ],
          this.currentConnectorRelation
        );
        relation.onchange = function() {
          self.currentConnectorRelation = this.value;
          self.updateWithSkels();
        };

        var relationLabel = document.createElement('label');
        relationLabel.appendChild(document.createTextNode('Type'));
        relationLabel.appendChild(relation);
        controls.appendChild(relationLabel);

        var sortingSelect = CATMAID.DOM.createSelect(
          self.idPrefix + "connector-sorting",
          [
            {title: 'Connector depth (proportion)', value: 'depthProportionSort'},
            {title: 'Connector depth (absolute)', value: 'depthSort'},
            {title: 'Connector ID', value: 'connIdSort'},
            {title: 'Skeleton name', value: 'skelNameSort'},
            {title: 'None', value: 'nullSort'}
          ],
          DEFAULT_SORT_FN_TITLE  // might need to be value, not title
        );
        sortingSelect.onchange = function() {
          self.currentConnectorOrder = [];
          self.cache.setSortFn(this.value);
          self.updateWithSkels();
        };
        self.cache.setSortFn(sortingSelect.value);

        var sortingSelectLabel = document.createElement('label');
        sortingSelectLabel.appendChild(document.createTextNode('Connector sorting'));
        sortingSelectLabel.appendChild(sortingSelect);
        controls.appendChild(sortingSelectLabel);

        var openTable = document.createElement('input');
        openTable.setAttribute('type', 'button');
        openTable.setAttribute('value', 'Table');
        openTable.onclick = function() {
          var selectedModels = self.resultSkeletonSource.getSelectedSkeletonModels();
          var connTable = WindowMaker.create('connector-table', selectedModels).widget;
          document.getElementById(connTable.idPrefix + 'relation-type').value = self.currentConnectorRelation;
          connTable.update();
        };
        controls.appendChild(openTable);

        controls.appendChild(document.createElement('br'));

        // PAGINATION CONTROLS

        var prevButton = document.createElement('input');
        prevButton.setAttribute('type', 'button');
        prevButton.setAttribute('id', self.idPrefix + "prev");
        prevButton.setAttribute('value', 'Previous');
        prevButton.onclick = function() {
          var prevPageIdx = Number(document.getElementById(self.idPrefix + "current-page").value) - 2;
          if (prevPageIdx >= 0) {
            self.changePage(prevPageIdx);
          }
        };
        controls.appendChild(prevButton);

        var pageCountContainer = document.createElement('div');
        pageCountContainer.style.display = 'inline-block';
        controls.appendChild(pageCountContainer);

        var currentPage = document.createElement('input');
        currentPage.setAttribute('type', 'text');
        currentPage.setAttribute('size', '4');
        currentPage.style.textAlign = 'right';
        currentPage.setAttribute('id', self.idPrefix + "current-page");
        currentPage.setAttribute('value', '1');
        currentPage.onchange = function() {
          self.changePage(Number(this.value) - 1);
        };

        pageCountContainer.appendChild(currentPage);

        pageCountContainer.appendChild(document.createTextNode(' / '));

        var maxPage = document.createElement('p');
        maxPage.innerHTML = '1';
        maxPage.setAttribute('id', self.idPrefix + 'max-page');

        pageCountContainer.appendChild(maxPage);

        var nextButton = document.createElement('input');
        nextButton.setAttribute('type', 'button');
        nextButton.setAttribute('id', self.idPrefix + 'next');
        nextButton.setAttribute('value', 'Next');
        nextButton.onclick = function() {
          // going from 1-base to 0-base so no +1 needed
          var nextPageIdx = Number(document.getElementById(self.idPrefix + 'current-page').value);

          var maxPageIdx = Number(document.getElementById(self.idPrefix + 'max-page').innerHTML) - 1;
          if (nextPageIdx <= maxPageIdx) {
            self.changePage(nextPageIdx);
          }
        };
        controls.appendChild(nextButton);

        var showing = document.createElement('p');
        showing.setAttribute('id', self.idPrefix + 'showing');
        showing.style.display = 'inline-block';
        showing.innerHTML = 'Showing <b class="start">0</b>-<b class="stop">0</b> of <b class="total">0</b> connectors';
        controls.appendChild(showing);
      },
      contentID: this.idPrefix + 'content',
      createContent: function(container) {
        container.setAttribute('position', 'relative');
      },
      init: function() {
        this.init(project.getId());
      }
    };
  };

  var skelIDsToModels = function(skelIDs) {
    return skelIDs.reduce(function(obj, skelID) {
      obj[skelID]  = new CATMAID.SkeletonModel(skelID);
      return obj;
    }, {});
  };

  ConnectorViewer.prototype.init = function() {
    this.initWidgetWindow();
    this.redrawPanels();
    this.updateWithSkels();
  };

  ConnectorViewer.prototype.initWidgetWindow = function () {
    var widgetWindow = this.getWidgetWindow();
    var self = this;

    widgetWindow.getWindows = function() {
      return [this].concat(self.panelWindows);
    };

    widgetWindow.redraw = function() {
      this.callListeners(CMWWindow.RESIZE);
      self.panelWindows.forEach(function(w) {
        w.redraw();
      });
    };
  };

  ConnectorViewer.prototype.getWidgetContent = function () {
    return document.getElementById(this.idPrefix + 'content');
  };

  ConnectorViewer.prototype.getWidgetWindow = function () {
    var widgetContent = this.getWidgetContent();
    var widgetFrame = $(widgetContent).closest('.' + CMWNode.FRAME_CLASS).get(0);
    return CATMAID.rootWindow.getWindows().find(function(w) {
      return w.getFrame() === widgetFrame;
    });
  };

  /**
   * Set the suspend state of a stack viewer's tracing layers, and redraw if waking it. Stack viewers set to
   * navigate with the project cannot be suspended.
   *
   * @param stackViewer
   * @param suspended - new suspend state, 'true' to suspend, 'false' to wake and redraw
   */
  var setStackViewerSuspendState = function(stackViewer, suspended) {
    // do not suspend if the stack viewer is set to navigate with project
    suspended = stackViewer.navigateWithProject ? false : suspended;

    for (let tracingLayer of stackViewer.getLayersOfType(CATMAID.TracingLayer)) {
      tracingLayer.tracingOverlay.suspended = suspended;
      if (!suspended) {
        tracingLayer.tracingOverlay.redraw(true);
      }
    }
  };

  /**
   * Return the set of nodes associated with any tracing overlay associated with the given stack viewer.
   *
   * @param stackViewer
   */
  var getNodeSet = function(stackViewer) {
    return stackViewer.getLayersOfType(CATMAID.TracingLayer).reduce(function (set, tracingLayer) {
      return set.addAll(Object.keys(tracingLayer.tracingOverlay.nodes));
    }, new Set());
  };

  /**
   * A listener to add to CMWWindows which will suspend tracing overlays which do not share nodes with the stack
   * viewer in the focused window.
   *
   * EDGE CASE: suspend decisions are made on focus change, so if you trace in one stack viewer, into the field of
   * view of a stack viewer which had been suspended due to being too far away, the latter will not unsuspend until
   * focused.
   *
   * @param cmwWindow
   * @param signal
   */
  ConnectorViewer.prototype.focusSuspendListener = function(cmwWindow, signal) {
    if (signal === CMWWindow.FOCUS) {
      let focusedStackViewer = this.stackViewers[this.panelWindows.indexOf(cmwWindow)];
      let focusedNodes = getNodeSet(focusedStackViewer);

      for (let stackViewer of this.stackViewers) {
        if (stackViewer === focusedStackViewer) {
          // avoid doing unnecessary set operations for the focused stack viewer
          setStackViewerSuspendState(stackViewer, false);
        } else {
          // suspend unless nodes in the focused stack viewer also appear in this stack viewer
          let otherNodes = getNodeSet(stackViewer);
          setStackViewerSuspendState(stackViewer, !focusedNodes.intersection(otherNodes).size);
        }
      }
    }
  };

  /**
   * Handle the redrawing of stack viewer panels, e.g. in the case of changing dimensions or the first draw.
   */
  ConnectorViewer.prototype.redrawPanels = function() {
    this.dimensions = [$(`#${this.idPrefix}h-tile-count`).val(), $(`#${this.idPrefix}w-tile-count`).val()];
    var widgetContent = this.getWidgetContent();

    // destroy existing
    this.closeStackViewers();
    this.stackViewers.length = 0;
    this.panelWindows.length = 0;
    while (widgetContent.lastChild) {
      widgetContent.removeChild(widgetContent.lastChild);
    }

    var widgetWindow = this.getWidgetWindow();

    var stack = this.sourceStackViewer.primaryStack;
    var tileSource = this.sourceStackViewer.getLayer('TileLayer').tileSource;

    var tileLayerConstructor = CATMAID.TileLayer.Settings.session.prefer_webgl ?
      CATMAID.PixiTileLayer :
      CATMAID.TileLayer;

    for (var iIdx = 0; iIdx < this.dimensions[0]; iIdx++) {
      for (var jIdx = 0; jIdx < this.dimensions[1]; jIdx++) {
        var panelContainer = document.createElement('div');
        panelContainer.style.position = 'absolute';
        panelContainer.style.height = `${100 / this.dimensions[0]}%`;
        panelContainer.style.width = `${100 / this.dimensions[1]}%`;
        panelContainer.style.top = `${(100 / this.dimensions[0]) * iIdx}%`;
        panelContainer.style.left = `${(100 / this.dimensions[1]) * jIdx}%`;

        widgetContent.appendChild(panelContainer);

        var panelInnerContainer = document.createElement('div');
        panelInnerContainer.style.position = 'absolute';
        panelInnerContainer.style.top = `${PANEL_PADDING}px`;
        panelInnerContainer.style.bottom = `${iIdx === this.dimensions[0]-1 ? 0 : PANEL_PADDING}px`;
        panelInnerContainer.style.left = `${jIdx ? PANEL_PADDING: 0}px`;
        panelInnerContainer.style.right = `${jIdx === this.dimensions[1]-1 ? 0 : PANEL_PADDING}px`;

        panelContainer.appendChild(panelInnerContainer);

        var panelWindow = new CMWWindow('Connector');
        // prevent dragging
        $(panelWindow.getFrame()).children('.stackInfo_selected').get(0).onmousedown = function () {return true;};
        panelWindow.parent = widgetWindow;

        var panel = panelWindow.getFrame();
        panel.style.position = 'absolute';
        panel.classList.add('connector-panel', `i${iIdx}`, `j${jIdx}`);

        var panelStackViewer = new CATMAID.StackViewer(project, stack, panelWindow);

        var tileLayer = new tileLayerConstructor(
          panelStackViewer,
          "Image data (" + stack.title + ")",
          stack,
          tileSource,
          true,
          1,
          false,
          CATMAID.TileLayer.Settings.session.linear_interpolation
        );

        panelStackViewer.addLayer("TileLayer", tileLayer);

        panelStackViewer.layercontrol.refresh();

        var stackInfo = panelStackViewer._stackWindow.frame.querySelector('.stackInfo_selected');
        var assocNeuronNameEl = document.createElement('p');
        assocNeuronNameEl.classList.add('assoc-neuron-name');
        stackInfo.appendChild(assocNeuronNameEl);

        this.stackViewers.push(panelStackViewer);

        panelInnerContainer.appendChild(panel);
        panelStackViewer.resize();

        var panelHider = document.createElement('div');
        panelHider.style.position = 'absolute';
        panelHider.style.height = '100%';
        panelHider.style.width = '100%';
        panelHider.style.backgroundColor = '#3d3d3d';
        panelHider.style.zIndex = HIDER_Z_INDEX;
        panelHider.setAttribute('id', `${this.idPrefix}hider-${iIdx}-${jIdx}`);

        panelInnerContainer.appendChild(panelHider);

        var hiderText = document.createElement('p');
        hiderText.style.color = 'white';
        hiderText.style.backgroundColor = 'transparent';
        hiderText.innerHTML = 'No more connectors to show';

        panelHider.appendChild(hiderText);

        project.addStackViewer(panelStackViewer);

        for (var keyVal of panelStackViewer.getLayers().entries()) {
          if (keyVal[0].startsWith('TracingLayer')) {
            keyVal[1].tracingOverlay.padding = TRACING_OVERLAY_BUFFER;
            break;
          }
        }

        panelWindow.redraw();

        panelWindow.addListener(this.focusSuspendListener.bind(this));  // todo: might need some binding here

        setStackViewerSuspendState(panelStackViewer, true);
      }
    }

    this.panelWindows = this.stackViewers.map(function(stackViewer) {
      return stackViewer.getWindow();
    });

    // todo: do this in the stack viewers rather than here
    // hide window controls
    var containerJq = $(widgetContent);
    containerJq.find('.neuronname').hide();
    containerJq.find('.stackClose').hide();
    containerJq.find('.smallMapView_hidden').hide();  // doesn't work anyway
  };

  ConnectorViewer.prototype.changeAssocNeuronName = function(container, skelNames) {
    container.querySelector('.assoc-neuron-name').innerHTML = skelNames.join(' | ');
  };

  ConnectorViewer.prototype.moveStackViewer = function(stackViewer, coords, completionCallback) {
    stackViewer.moveToProject(
      coords.z, coords.y, coords.x,
      this.sourceStackViewer.primaryStack.stackToProjectSX(this.sourceStackViewer.s),
      typeof completionCallback === "function" ? completionCallback : undefined
    );
  };

  /**
   * Update panel stack viewer state (hidden, title, position etc.) based on current skeleton source content. Used when
   * dimensions or page changed.
   */
  ConnectorViewer.prototype.update = function() {
    var self = this;
    this.currentConnectorRelation = $(`#${this.idPrefix}relation-type`).val();

    var visibleConnectors = this.getVisibleConnectors();
    for (var iIdx = 0; iIdx < self.dimensions[0]; iIdx++) {
      for (var jIdx = 0; jIdx < self.dimensions[1]; jIdx++) {
        var panelIdx = jIdx + iIdx*self.dimensions[1];
        var hider = document.getElementById(`${self.idPrefix}hider-${iIdx}-${jIdx}`);

        var panelStackViewer = self.stackViewers[panelIdx];
        panelStackViewer.navigateWithProject = false;
        panelStackViewer.updateScaleBar(self.showScaleBar);

        var connector = visibleConnectors[panelIdx];
        if (connector) {
          // change title bar
          panelStackViewer._stackWindow.setTitle('connector ID: ' + connector.connID);
          panelStackViewer._stackWindow.frame.querySelector('.stackTitle').onclick = self.moveStackViewer
            .bind(self, self.sourceStackViewer, connector.coords);
          self.changeAssocNeuronName(panelStackViewer._stackWindow.frame, connector.skelNames);

          // allow the tracing overlay to update for the move
          setStackViewerSuspendState(panelStackViewer, false);
          self.moveStackViewer(
            panelStackViewer, connector.coords,
            setStackViewerSuspendState.bind(self, panelStackViewer, true)
          );

          hider.style.display = 'none';
        } else {
          hider.style.display = 'block';
        }
      }
    }

    self.updateShowingText();
  };

  /**
   * Update result skeleton source, cache and connector order, and then panel stack viewer state.
   *
   * @returns Promise of connector order
   */
  ConnectorViewer.prototype.updateWithSkels = function() {
    var self = this;
    this._updateResultSkelSource();
    // this.cache.invalidateSort(this.currentConnectorRelation);
    return this.updateConnectorOrder().then(function(connectorOrder) {
      var maxPageElement = document.getElementById(self.idPrefix + 'max-page');
      var maxPage = Math.ceil(connectorOrder.length / (self.dimensions[0]*self.dimensions[1]));
      maxPageElement.innerHTML = Math.max(maxPage, 1).toString();
      self.changePage(0);

      return connectorOrder;
    });
  };

  ConnectorViewer.prototype._updateResultSkelSource = function() {
    this.resultSkeletonSource.clear();
    // Populate result skeleton source
    var models = skelIDsToModels(this.skeletonSource.getSelectedSkeletons());
    this.resultSkeletonSource.append(models);
  };

  // Export widget
  CATMAID.ConnectorViewer = ConnectorViewer;

  // Register widget with CATMAID
  CATMAID.registerWidget({
    key: 'connector-viewer',
    creator: ConnectorViewer
  });

  /**
   * Acts as a cache and controls database access for the connector viewer.
   *
   * EDGE CASES:
   *  - Doesn't pick up if a treenode and connector lose their association during use
   *  - Doesn't pick up if a treenode's depth on a skeleton changes
   *
   *  All are solved by clearing or refreshing the cache.
   *
   * @constructor
   */
  var ConnectorViewerCache = function(skeletonSource) {
    this.relationTypes = {
      '0': 'presynaptic_to',
      '1': 'postsynaptic_to',
      '2': 'gapjunction_with',
      '-1': 'abutting'
    };

    /**
     *  {
     *    connID1: {
     *      'coords': {'x': _, 'y': _, 'z': _},
     *      'relationType': {
     *        'postsynaptic_to':   Set([treenodeID1, treenodeID2, ...]),
     *        'presynaptic_to':    Set([treenodeID1, treenodeID2, ...]),
     *        'gapjunction_with':  Set([treenodeID1, treenodeID2, ...]),
     *        'abutting':          Set([treenodeID1, treenodeID2, ...])
     *      }
     *    },
     *    connID2...
     *  }
     */
    this.connectors = {};

    /**
     *  {
     *    skelID1: {
     *      'arborTimestamp': _,
     *      'name': _,
     *      'nameTimestamp': _,
     *      'maxDepth': _
     *    },
     *    skelID2...
     *  }
     */
    this.skeletons = {};

    /**
     *  {
     *    treenodeID1: {
     *      'skelID': _,
     *      'depth': _
     *    },
     *    treenodeID2: ...
     *  }
     */
    this.treenodes = {};

    this.sortFn = null;

    this.sorting = {
      'postsynaptic_to':   {sortFn: this.sortFn, order: new Set(), sorted: false},
      'presynaptic_to':    {sortFn: this.sortFn, order: new Set(), sorted: false},
      'gapjunction_with':  {sortFn: this.sortFn, order: new Set(), sorted: false},
      'abutting':          {sortFn: this.sortFn, order: new Set(), sorted: false}
    };

    this.skeletonSource = skeletonSource;
  };

  ConnectorViewerCache.prototype = {};

  ConnectorViewerCache.prototype.clear = function() {
    this.connectors = {};
    this.skeletons = {};
    this.sorting = {
      'postsynaptic_to':   {sortFn: this.sortFn, order: new Set(), sorted: false},
      'presynaptic_to':    {sortFn: this.sortFn, order: new Set(), sorted: false},
      'gapjunction_with':  {sortFn: this.sortFn, order: new Set(), sorted: false},
      'abutting':          {sortFn: this.sortFn, order: new Set(), sorted: false}
    };
    this.treenodes = {};
  };

  ConnectorViewerCache.prototype.refresh = function() {
    this.clear();
    return this.ensureValidCache();
  };

  /**
   * Return the order of connectors associated with the current selected skeletons by the given relation type, using
   * the ConnectorViewerCache's stored sorting function.
   *
   * @param relationType
   * @returns Promise of conector order
   */
  ConnectorViewerCache.prototype.updateConnectorOrder = function(relationType) {
    var self = this;
    var order;

    return this.ensureValidCache().then(function() {
      var selectedSkeletons = self.skeletonSource.getSelectedSkeletons();
      var sortInfo = self.sorting[relationType];

      if (sortInfo.sorted && sortInfo.sortFn === self.sortFn) {
        order = Array.from(sortInfo.order);
      } else {
        // re-sort using the stored sort function
        sortInfo.sortFn = self.sortFn;
        order = Array.from(sortInfo.order).sort(function(connID1, connID2) {
          return self.sortFn(connID1, connID2, relationType, selectedSkeletons);
        });

        // update the sorting cache
        sortInfo.order = new Set(order);
        sortInfo.sorted = true;
      }

      // turn the array of connector IDs into informative objects
      return order.map(function(connID) {
        return {
          connID: connID,
          coords: self.connectors[connID].coords,
          skelNames: Array.from(self.connectors[connID].relationType[relationType])
            .reduce(function(arr, treenodeID) {
              let skelID = self.treenodes[treenodeID].skelID;
              let skelName = self.skeletons[skelID].name;

              // only add distinct skeleton IDs, and only skeleton IDs which are in the selected skeletons (they
              // might just be associated with treenodes which are associated with connectors which are associated
              // with selected skeletons)
              if (!arr.includes(skelName) && selectedSkeletons.includes(skelID)) {
                arr.push(skelName);
              }

              return arr;
            }, [])
            .sort()  // sort alphanumerically to keep it deterministic
        };
      });
    });
  };

  /**
   * Ensure that all of the currently selected skeletons have recent representations in the cache.
   *
   * @returns {Promise.<*>}
   */
  ConnectorViewerCache.prototype.ensureValidCache = function() {
    var self = this;
    var promises = this.skeletonSource.getSelectedSkeletons().map(self.ensureValidCacheForSkel.bind(self));
    return Promise.all(promises);
  };

  /**
   * Ensure that a given skeleton has a recent representation in the cache.
   *
   * @param skelID
   * @returns {Promise}
   */
  ConnectorViewerCache.prototype.ensureValidCacheForSkel = function(skelID) {
    var self = this;
    var now = Date.now();

    if (skelID in this.skeletons && now - this.skeletons[skelID].arborTimestamp < CACHE_TIMEOUT) {
      return Promise.resolve();  // cache is recent for this skeleton
    }

    // cache is not recent for this skeleton: fetch it from the database
    return CATMAID.fetch(`${project.id}/skeletons/${skelID}/compact-detail`, 'GET', {with_connectors: true})
      .then(function(json) {
        var arborParser = new CATMAID.ArborParser();

        // this object will calculate treenode depth
        var arbor = arborParser.init('compact-skeleton', json).arbor;

        if (!(skelID in self.skeletons)) {
          // name uses a different API endpoint so needs a different timestamp
          self.skeletons[skelID] = {name: null, nameTimestamp: -CACHE_TIMEOUT};
        }
        self.skeletons[skelID].arborTimestamp = now;

        // get the maximum depth of the tree, as a sum of node-to-node euclidean distances, from the root
        var root = arbor.findRoot();
        var distancesObj = arbor.nodesDistanceTo(root, self.euclideanDistance.bind(self, arborParser.positions));
        self.skeletons[skelID].maxLength = distancesObj.max;

        // get all the connectors associated with the given skeleton by any relation type
        var connectorsResponse = json[1];
        for (var i = 0; i < connectorsResponse.length; i++) {
          // turn the array response into more readable objects
          let connectorResponse = connectorsResponse[i];
          let treenodeID = connectorResponse[0];
          let connID = connectorResponse[1];
          let relationType = self.relationTypes[connectorResponse[2]];
          let coords = {
            x: connectorResponse[3],
            y: connectorResponse[4],
            z: connectorResponse[5]
          };

          // insert information from this skeleton into the connectors cache
          if (!(connID in self.connectors)) {
            self.connectors[connID] = {
              coords: null,
              relationType: {
                postsynaptic_to: new Set(),
                presynaptic_to: new Set(),
                gapjunction_with: new Set(),
                abutting: new Set()
              }
            };
          }
          self.connectors[connID].coords = coords;
          self.connectors[connID].relationType[relationType].add(treenodeID);

          // insert information from this skeleton into the sorting cache if it's not there, and flag it for re-sorting
          if (!self.sorting[relationType].order.has(connID)) {
            self.sorting[relationType].order.add(connID);
            self.sorting[relationType].sorted = false;
          }

          // insert information from this skeleton into the treenodes cache (only treenodes associated with connectors)
          self.treenodes[treenodeID] = {
            skelID: skelID,
            depth: distancesObj.distances[treenodeID]
          };
        }
      })
      .then(self.ensureValidCacheForSkelName.bind(self, skelID));  // ensure name is up-to-date
  };

  /**
   * Ensure that the given skeleton's name has a recent representation in the cache.
   *
   * @param skelID
   * @returns {*}
   */
  ConnectorViewerCache.prototype.ensureValidCacheForSkelName = function(skelID) {
    var self = this;
    var now = Date.now();

    if ( this.skeletons[skelID].name && now - this.skeletons[skelID].nameTimestamp < CACHE_TIMEOUT ) {
      // name is recent
      return Promise.resolve();
    } else {
      // get name from database and add it to the skeletons cache
      return CATMAID.fetch(project.id + '/skeleton/' + skelID + '/neuronname', 'GET').then(function(json) {
        self.skeletons[skelID].name = json.neuronname;
        self.skeletons[skelID].nameTimestamp = now;
      });
    }
  };

  /**
   * This is bound to the positions property of an initialised Arbor instance.
   *
   * @param positions - object of treenode ID : THREE.Vector instances of x y z position, as found in the
   * 'positions' property of an initialised Arbor instance.
   * @param child - a treenode ID
   * @param parent - a treenode ID
   * @returns {*|number}
   */
  ConnectorViewerCache.prototype.euclideanDistance = function(positions, child, parent) {
    return positions[child].distanceTo(positions[parent]);
  };

  /**
   *
   * @param sortFnName A string which is the property name, in the sortFns object, of a comparator function. The
   * function will be bound to the ConnectorViewerCache, and should have the signature
   * function(connector1ID, connector2ID, relationType, selectedSkeletons)
   */
  ConnectorViewerCache.prototype.setSortFn = function (sortFnName) {
      this.sortFn = sortFns[sortFnName].bind(this);  // is the binding necessary here?
  };

  /**
   * Get the depth of a given connector on its associated selected skeleton by the given relationType, in absolute
   * terms or as a proportion of the skeleton's maximum depth.
   *
   * As connectors of some relation type can be associated with multiple skeletons, this only counts those which are
   * in the given selection, and if there are multiple such skeletons, returns the smallest depth.
   *
   * @param relationType
   * @param selectedSkeletons
   * @param proportional
   * @param connID
   * @returns {Number}
   */
  ConnectorViewerCache.prototype.getMinDepth = function(relationType, selectedSkeletons, proportional, connID) {
    var minConnDepth = Infinity;

    for (let treenodeID of this.connectors[connID].relationType[relationType]) {
      if (selectedSkeletons.includes(this.treenodes[treenodeID].skelID)) {
        let treenodeInfo = this.treenodes[treenodeID];
        let depth = proportional ? treenodeInfo.depth / this.skeletons[treenodeInfo.skelID].maxLength : treenodeInfo.depth;
        minConnDepth = Math.min(minConnDepth, depth);
      }
    }

    return minConnDepth;
  };

  /**
   * Get a skeleton name associated with a connector by the given relation type.
   *
   * As connectors of some relation type can be associated with multiple skeletons, this only counts those which are
   * in the given selection, and if there are multiple such skeletons, returns the first skeleton by alphanumeric sort.
   *
   * @param relationType
   * @param selectedSkeletons
   * @param connID
   * @returns {String}
   */
  ConnectorViewerCache.prototype.getFirstSkelName = function(relationType, selectedSkeletons, connID) {
    var skelNames = [];

    for (let treenodeID of this.connectors[connID].relationType[relationType]) {
      if (selectedSkeletons.includes(this.treenodes[treenodeID].skelID)) {
        skelNames.push(this.skeletons[this.treenodes[treenodeID].skelID].name);
      }
    }

    return skelNames.sort()[0];
  };

  /**
   * Object containing comparator functions to be passed to Array.sort().
   *
   * Members will be bound to the ConnectorViewerCache before usage and should have the signature
   * function(connector1ID, connector2ID, relationType, selectedSkeletons).
   */
  const sortFns = {};

  /**
   * Sort connectors by how far they are from their associated skeleton's root node. Only skeletons which are in
   * the given array of selected skeletons are counted, and only if they are associated with the connector by the
   * given relation type. If there are multiple such skeletons, the smallest depth is used.
   *
   * @param connID1
   * @param connID2
   * @param relationType
   * @param selectedSkeletons
   * @returns {number}
   */
  sortFns.depthSort = function(connID1, connID2, relationType, selectedSkeletons) {
    var self = this;
    var minConnDepths = [connID1, connID2]
      .map(self.getMinDepth.bind(self, relationType, selectedSkeletons, false));

    return minConnDepths[0] - minConnDepths[1];
  };

  /**
   * Similar to sortFns.depthSort, but returns depths as a proportion of the maximum length of the skeleton.
   *
   * @param connID1
   * @param connID2
   * @param relationType
   * @param selectedSkeletons
   * @returns {number}
   */
  sortFns.depthProportionSort = function(connID1, connID2, relationType, selectedSkeletons) {
    var self = this;
    var minConnDepthPpns = [connID1, connID2]
      .map(self.getMinDepth.bind(self, relationType, selectedSkeletons, true));

    return minConnDepthPpns[0] - minConnDepthPpns[1];
  };

  sortFns.connIdSort = function(connID1, connID2) {
    return connID1 - connID2;
  };

  /**
   * Not guaranteed to preserve the current sort order
   */
  sortFns.nullSort = function() {
    return 0;
  };

  sortFns.skelNameSort = function(connID1, connID2, relationType, selectedSkeletons) {
    var self = this;
    var skelNames = [connID1, connID2].map(self.getFirstSkelName.bind(self, relationType, selectedSkeletons));

    return skelNames[0].localeCompare(skelNames[1]);
  };

})(CATMAID);
