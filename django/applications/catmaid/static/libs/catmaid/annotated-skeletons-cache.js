/* -*- mode: espresso; espresso-indent-level: 2; indent-tabs-mode: nil -*- */
/* vim: set softtabstop=2 shiftwidth=2 tabstop=2 expandtab: */

(function(CATMAID) {

  "use strict";

  /**
   * This cache tracks the IDs of all skeletons modeling neurons annotated
   * with (meta-)annotations registered with the cache.
   */
  var AnnotatedSkeletonsCache = function() {
    this.trackedAnnotations = {};

    /**
     * Whether to refresh an annotation as soon as it is changed on the client.
     * @type {Boolean}
     */
    this.EAGER_REFRESH = false;

    // Listen to annotation deletions so these annotations can be reomved from
    // the cache.
    CATMAID.Annotations.on(CATMAID.Annotations.EVENT_ANNOTATIONS_DELETED,
        this._handleDeletedAnnotations, this);
    CATMAID.Annotations.on(CATMAID.Annotations.EVENT_ANNOTATIONS_CHANGED,
        this._handleChangedAnnotations, this);
  };

  AnnotatedSkeletonsCache.prototype._getTrackedAnnotation = function (annotationName) {
    if (!this.trackedAnnotations.hasOwnProperty(annotationName)) {
      throw new CATMAID.ValueError('Annotation is not tracked by cache: ' + annotationName);
    }

    return this.trackedAnnotations[annotationName];
  };

  AnnotatedSkeletonsCache.prototype.refresh = function (annotationName) {
    var tracked = this._getTrackedAnnotation(annotationName);
    var self = this;
    var meta = [false, false];
    tracked.registered.forEach(function (registered) {
      meta[registered.includeMeta ? 1 : 0] = true;
    });

    var refreshWithMeta = function(includeMeta) {
      var params = {annotated_with: tracked.id, types: 'neuron'};
      if (includeMeta) params.sub_annotated_with = tracked.id;
      CATMAID
          .fetch(project.id + '/annotations/query-targets',
                 'POST', params)
          .then(function (json) {
            var skids = json.entities.reduce(function (a, e) {
              return a.concat(e.skeleton_ids);
            }, []);
            var newSkeletonIds = new Set(skids);

            if (!CATMAID.tools.areSetsEqual(tracked.skeletonIDs[includeMeta ? 1 : 0], newSkeletonIds)) {
              tracked.skeletonIDs[includeMeta ? 1 : 0] = newSkeletonIds;
              self.notify(annotationName, includeMeta);
            }
          });
    };

    if (meta[0]) {
      refreshWithMeta(false);
    }

    if (meta[1]) {
      refreshWithMeta(true);
    }
  };

  AnnotatedSkeletonsCache.prototype.notify = function (annotationName, includeMeta) {
    var tracked = this._getTrackedAnnotation(annotationName);
    var includeBoth = typeof includeMeta === 'undefined';
    includeMeta = !!includeMeta;

    tracked.registered.forEach(function (registered) {
      if (includeBoth || includeMeta === registered.includeMeta) {
        registered.callback(annotationName,
                            tracked.skeletonIDs[registered.includeMeta ? 1 : 0]);
      }
    });
  };

  AnnotatedSkeletonsCache.prototype.register = function (annotationName, callback, includeMeta) {
    var newlyTracked = false;
    if (this.trackedAnnotations.hasOwnProperty(annotationName)) {
      var tracked = this.trackedAnnotations[annotationName];
    } else {
      newlyTracked = true;
      var tracked = {
        id: CATMAID.annotations.getID(annotationName),
        registered: new Set(),
        skeletonIDs: [new Set(), new Set()],
      };
      this.trackedAnnotations[annotationName] = tracked;
    }

    tracked.registered.add({callback: callback, includeMeta: !!includeMeta});

    if (newlyTracked) this.refresh(annotationName);
  };

  AnnotatedSkeletonsCache.prototype.unregister = function (annotationName, callback, includeMeta) {
    var tracked = this._getTrackedAnnotation(annotationName);
    var includeBoth = typeof includeMeta === 'undefined';
    includeMeta = !!includeMeta;
    tracked.registered.forEach(function (entry) {
      if (callback === entry.callback && (includeBoth || includeMeta === entry.includeMeta)) {
        tracked.registered.delete(entry);
      }
    });

    if (tracked.registered.size === 0) {
      delete this.trackedAnnotations[annotationName];
    }
  };

  AnnotatedSkeletonsCache.prototype._handleDeletedAnnotations = function (annotationIDs) {
    // Cannot rely on annotation cache to get name from ID, because it may have
    // already removed this entry.

    Object.keys(this.trackedAnnotations).forEach(function (annotationName) {
      var tracked = this.trackedAnnotations[annotationName];

      if (-1 !== annotationIDs.indexOf(tracked.id)) {
        tracked.skeletonIDs[0].clear();
        tracked.skeletonIDs[1].clear();
        this.notify(annotationName);
        tracked.registered.clear();

        delete this.trackedAnnotations[annotationName];
      }
    }, this);
  };

  AnnotatedSkeletonsCache.prototype._handleChangedAnnotations = function (changedObjects, annotationList) {
    if (!this.EAGER_REFRESH) return;

    annotationList.forEach(function (a) {
      if (this.trackedAnnotations.hasOwnProperty(a.name)) {
        this.refresh(a.name);
      }
    });
  };

  // Export the annotation cache constructor and a generally available instance.
  CATMAID.AnnotatedSkeletonsCache = AnnotatedSkeletonsCache;
  CATMAID.annotatedSkeletons = new CATMAID.AnnotatedSkeletonsCache();

})(CATMAID);