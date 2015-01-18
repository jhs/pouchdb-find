'use strict';

var utils = require('../../utils');
var upsert = require('pouchdb-upsert');
var callbackify = utils.callbackify;

var abstractMapper = require('./abstract-mapper');

function getKey(obj) {
  return Object.keys(obj)[0];
}

function getValue(obj) {
  return obj[getKey(obj)];
}

function getSize(obj) {
  return Object.keys(obj).length;
}

function putIfNotExists(db, doc) {
  return upsert.putIfNotExists.call(db, doc);
}

function massageIndexDef(indexDef) {
  indexDef.fields = indexDef.fields.map(function (field) {
    if (typeof field === 'string') {
      var obj = {};
      obj[field] = 'asc';
      return obj;
    }
    return field;
  });
  return indexDef;
}

function massageSelector(selector) {
  if (!selector) {
    return null;
  }
  var field = Object.keys(selector)[0];
  var matcher = selector[field];
  if (typeof matcher === 'string') {
    matcher = {$eq: matcher};
  }
  matcher = {
    operator: getKey(matcher),
    value: getValue(matcher)
  };
  return [
    {field: field, matcher: matcher}
  ];
}

function createIndex(db, requestDef) {

  var originalIndexDef = utils.clone(requestDef.index);
  requestDef.index = massageIndexDef(requestDef.index);

  var md5 = utils.MD5(JSON.stringify(requestDef));

  var views = {};

  views[requestDef.name] = {
    map: {
      fields: utils.mergeObjects(requestDef.index.fields)
    },
    reduce: '_count',
    options: {
      def: originalIndexDef
    }
  };

  return putIfNotExists(db, {
    _id: '_design/idx-' + md5,
    views: views,
    language: 'query'
  }).then(function (res) {
    return {result: res.updated ? 'created' : 'exists'};
  });
}

function find(db, requestDef) {

  return getIndexes(db).then(function (getIndexesRes) {

    var selector = massageSelector(requestDef.selector)[0];
    var matcher = selector.matcher;

    var indexToUse;
    if (selector.field === '_id') {
      indexToUse = '_all_docs';
    } else {
      getIndexesRes.indexes.forEach(function (index) {
        if (index.def.fields.length === 1 &&
            getKey(index.def.fields[0]) === selector.field) {
          var ddoc = index.ddoc.substring(8); // remove '_design/'
          indexToUse = ddoc + '/' + index.name;
        }
      });
    }
    if (!indexToUse) {
      throw new Error('couldn\'t find any index to use');
    }

    var opts = {
      include_docs: true,
      reduce: false
    };

    if (requestDef.sort && requestDef.sort.length === 1 &&
        getSize(requestDef.sort[0]) === 1 &&
        getKey(requestDef.sort[0]) === selector.field &&
        getValue(requestDef.sort[0]) === 'desc') {
      opts.descending = true;
    }

    switch (matcher.operator) {
      case '$eq':
        opts.key = matcher.value;
        break;
      case '$lte':
        if (opts.descending) {
          opts.startkey = matcher.value;
        } else {
          opts.endkey = matcher.value;
        }
        break;
      case '$gte':
        if (opts.descending) {
          opts.endkey = matcher.value;
        } else {
          opts.startkey = matcher.value;
        }
        break;
    }

    if (indexToUse === '_all_docs') {
      return db.allDocs(opts);
    } else {
      return abstractMapper.query.call(db, indexToUse, opts);
    }
  }).then(function (res) {
    return {
      docs: res.rows.map(function (row) {
        var doc = row.doc;
        if (requestDef.fields) {
          return utils.pick(doc, requestDef.fields);
        }
        return doc;
      })
    };
  });
}

function getIndexes(db) {
  return db.allDocs({
    startkey: '_design/idx-',
    endkey: '_design/idx-\uffff',
    include_docs: true
  }).then(function (allDocsRes) {
    var res = {
      indexes: [{
        ddoc: null,
        name: '_all_docs',
        type: 'special',
        def: {
          fields: [{_id: 'asc'}]
        }
      }]
    };

    res.indexes = utils.flatten(res.indexes, allDocsRes.rows.map(function (row) {
      var viewNames = Object.keys(row.doc.views);

      return viewNames.map(function (viewName) {
        var view = row.doc.views[viewName];
        return {
          ddoc: row.id,
          name: viewName,
          type: 'json',
          def: massageIndexDef(view.options.def)
        };
      });
    }));

    return res;
  });
}

function deleteIndex(db, indexDef) {
  throw new Error('not implemented');
}

exports.createIndex = callbackify(createIndex);
exports.find = callbackify(find);
exports.getIndexes = callbackify(getIndexes);
exports.deleteIndex = callbackify(deleteIndex);