/**
 *
 * The source code included in this file is licensed to you by Facebook under
 * the Apache License, Version 2.0.  Accordingly, the following notice
 * applies to the source code included in this file:
 *
 * Copyright © 2009 Facebook, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License. You may obtain
 * a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 *
 */


// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;
const CC = Components.Constructor;
const Cu = Components.utils;

const FileInputStream = CC("@mozilla.org/network/file-input-stream;1",
                           "nsIFileInputStream",
                           "init");
const StringInputStream = CC("@mozilla.org/io/string-input-stream;1",
                             "nsIStringInputStream")

// Global objects.

// JavaScript semantics is required for some member access, that's why
// we use wrappedJSObject instead of going throught the .idl.
var gFacebookService =  Cc['@facebook.com/facebook-service;1'].
                        getService(Ci.fbIFacebookService).
                        wrappedJSObject;
// Unwrapped version.
var gFacebookServiceUnwrapped =  Cc['@facebook.com/facebook-service;1'].
                                 getService(Ci.fbIFacebookService);


// Compatibility with Firefox 3.0 that doesn't have native JSON.
if (typeof(JSON) == "undefined") {
  Components.utils.import("resource://gre/modules/JSON.jsm");
  JSON.parse = JSON.fromString;
  JSON.stringify = JSON.toString;
}

const DEBUG = false;

// Debugging.
function LOG(s) {
  if (DEBUG)
    dump(s + "\n");
}

var QuitObserver = {
  observe: function(subject, topic, data) {
    switch (topic) {
      case "quit-application-requested":
        if (!PhotoUpload.canClose()) {
          // deny the application close request
          try {
            let cancelQuit = subject.QueryInterface(Components.interfaces.nsISupportsPRBool);
            cancelQuit.data = true;
          } catch (ex) {
            LOG("cannot cancel quit: " + ex);
          }
        }
      break;
    }
  }
};

/**
 * Base class for representing a photo tag.
 */
function Tag(label, x, y) {
  this.label = label;
  this.x = x;
  this.y = y;
}
Tag.prototype = {
  getUploadObject: function() {
    var uploadObject = {
      x: this.x,
      y: this.y
    };
    var [key, value] = this.getUploadObjectKeyValue();
    uploadObject[key] = value;
    return uploadObject;
  }
}

/**
 * Class for text based tags.
 */
function TextTag(text, x, y) {
  Tag.call(this, text, x, y);
  this.text = text;
}
TextTag.prototype = {
  __proto__: Tag.prototype,
  getUploadObjectKeyValue: function() {
    return ["tag_text", this.text];
  },
  toString: function() {
    return "<TextTag " + this.text + ">";
  }
}

/**
 * Object that represents a friend.
 */
function Friend(name, uid) {
  this.name = name;
  this.uid = uid;
}
Friend.prototype = {
  toString: function() {
    return "<Friend name: '" + this.name + "' uid: " + this.uid + ">";
  }
};

/**
 * Class for people based tags.
 */
function PeopleTag(friend, x, y) {
  Tag.call(this, friend.name, x, y);
  this.friend = friend;
}
PeopleTag.prototype = {
  __proto__: Tag.prototype,
  getUploadObjectKeyValue: function() {
    return ["tag_uid", this.friend.uid];
  },
  toString: function() {
    return "<PeopleTag " + this.friend + ">";
  }
}

/**
 * This objects represents a photo that is going to be uploaded.
 */
function Photo(/* nsIFile */ file) {
  this.file = file.QueryInterface(Ci.nsIFile);
  this.caption = "";
  this.tags = [];
  this._facebookSize = null;
  this._size = null;
  this.__mimeType = null;
  this.__container = null;
};

Photo.prototype = {
  MAX_WIDTH: 604,
  MAX_HEIGHT: 604,

  get url() {
    var ios = Cc["@mozilla.org/network/io-service;1"].
              getService(Ci.nsIIOService);
    return ios.newFileURI(this.file).spec;
  },

  get _mimeType() {
    if (this.__mimeType)
      return this.__mimeType;
    var filename = this.filename;
    var extension = filename.substring(filename.lastIndexOf("."),
                                       filename.length).toLowerCase();

    var mimeSvc = Cc["@mozilla.org/mime;1"].getService(Ci.nsIMIMEService);
    extension = extension.toLowerCase();
    var dotPos = extension.lastIndexOf(".");
    if (dotPos != -1)
      extension = extension.substring(dotPos + 1, extension.length);
    return this.__mimeType = mimeSvc.getTypeFromExtension(extension);
  },

  get _inputStream() {
    const PR_RDONLY = 0x01;
    var fis = new FileInputStream(this.file, PR_RDONLY, 0444, null);

    var imageStream = Cc["@mozilla.org/network/buffered-input-stream;1"].
                      createInstance(Ci.nsIBufferedInputStream);
    imageStream.init(fis, 4096);
    return imageStream;
  },

  get _container() {
    if (this.__container)
      return this.__container;

    var imgTools = Cc["@mozilla.org/image/tools;1"].
                   getService(Ci.imgITools);
    LOG("Found mime: " + this._mimeType + " for file " + this.filename);
    var outParam = { value: null };
    imgTools.decodeImageData(this._inputStream, this._mimeType, outParam);
    return this.__container = outParam.value;
  },

  get size() {
    if (this._size)
      return this._size;
    var container = this._container;
    return this._size = [container.width, container.height];
  },

  get facebookSize() {
    if (this._facebookSize)
      return this._facebookSize;

    if (this.size[0] < this.MAX_WIDTH && this.size[1] < this.MAX_HEIGHT) {
      return this._facebookSize = this.size;
    }
    var [oldWidth, oldHeight] = this.size;
    LOG("resizing image. Original size: " + oldWidth + " x " + oldHeight);
    var newWidth, newHeight;
    var ratio = oldHeight / oldWidth;
    if (oldWidth > this.MAX_WIDTH) {
      newWidth = this.MAX_WIDTH;
      newHeight = oldHeight * (this.MAX_WIDTH / oldWidth);
    } else if (oldHeight > this.MAX_HEIGHT) {
      newHeight = this.MAX_HEIGHT;
      newWidth = oldWidth * (this.MAX_HEIGHT / oldHeight);
    } else {
      LOG("Unexpected state");
    }
    LOG("new size: " + [newWidth, newHeight]);
    return this._facebookSize = [newWidth, newHeight];
  },

  get sizeInBytes() {
    return this.file.fileSize;
  },
  get filename() {
    return this.file.leafName;
  },
  addTag: function(tag) {
    this.tags.push(tag);
  },
  removeTag: function(tag) {
    this.tags = this.tags.filter(function(p) p != tag);
  },
  toString: function() {
    return "<Photo file: " + this.filename + ">";
  },

  get resizedInputStream() {
    var fbSize = this.facebookSize;
    if (this.size[0] == fbSize[0] &&
        this.size[1] == fbSize[1]) {
      LOG("no resizing needed");
      return this._inputStream;
    }
    var imgTools = Cc["@mozilla.org/image/tools;1"].
                   getService(Ci.imgITools);
    try {
      return imgTools.encodeScaledImage(this._container, this._mimeType, fbSize[0], fbSize[1]);
    } catch (e) {
      throw "Failure while resizing image: " + e;
    }
  }
};

const BOUNDARY = "facebookPhotoUploaderBoundary";

// Change notification constants:

// All photos are removed. No parameter.
const CHANGE_REMOVE_ALL = "removeAll";
// A photo is removed. Parameter is the removed photo.
const CHANGE_REMOVE = "remove";
// A photo is added. Parameter is the added photo.
const CHANGE_ADD = "add";
// A photo is updated. Parameter is the updated photo
const CHANGE_UPDATE = "update";
// The selected photo changes. Parameter is the new selected photo.
const CHANGE_SELECTED = "selected";

/**
 * This object (singleton) represent the list of photos that will be uploaded
 * or that can be edited.
 */
var PhotoSet = {
  // Array of Photo objects.
  _photos: [],
  // Currently selected Photo object.
  _selected: null,
  // Listeners wanted to get notified when a photo changes.
  // Stored as (function callback, context object) pairs.
  _listeners: [],
  _cancelled: false,

  add: function(photos) {
    // don't re-add any photos (bug 913)
    var photos2 = [];

    outer: for (var i=0; i<photos.length; i++) {
      for (var j=0; j<this._photos.length; j++) {
        if (this._photos[j].file && this._photos[j].file.equals(photos[i].file)) {
          LOG("will not add duplicate image");
          //delete photos[i];
          continue outer;
        }
      }

      photos2.push(photos[i]);
    }

    if (photos2.length == 0) {
        this._selected = photos[photos.length - 1];
        return;
    }

    Array.prototype.push.apply(this._photos, photos2)
    this._notifyChanged(CHANGE_ADD, photos2);

    // Selects the last added photos. When adding only one photo, that's
    // useful to have it selected for direct metadata editing.
    this._selected = photos2[photos2.length - 1];
    this._updateSelected();
  },

  _updateSelected: function() {
    var p = this._photos.filter(function(p) p == this._selected, this);
    if (p.length > 1) {
      LOG("ERROR: more that one selected photo?");
      return;
    }
    if (p.length == 0) {
      LOG("No selected photo");
      this._selected = null;
    }
    this._notifyChanged(CHANGE_SELECTED, this._selected);
  },

  removeAll: function() {
    this._photos = [];
    this._notifyChanged(CHANGE_REMOVE_ALL);
    this._updateSelected();
  },

  remove: function(photo) {
    var photoIndex = this._photos.indexOf(photo);
    if (photoIndex == -1) {
      LOG("Warning: trying to remove a photo not in set");
      return;
    }
    this._photos.splice(photoIndex, 1);
    this._notifyChanged(CHANGE_REMOVE, photo);

    // Select the photo just after the removed one.
    var selectedIndex = Math.min(photoIndex, this._photos.length - 1);
    this._selected = this._photos[selectedIndex];
    this._updateSelected();
  },

  _ensurePhotoExists: function(photo) {
    var p = this._photos.filter(function(p) p == photo);
    if (p.length == 0) {
      LOG("ERROR: photo does not exist in set");
      return false;
    }
    if (p.length > 1) {
      LOG("ERROR: more than one photo matching?");
      return false;
    }
    return true;
  },

  update: function(photo) {
    if (!this._ensurePhotoExists(photo))
      return;

    // The modified photo should be a reference to the photo in the set.
    // So there is nothing to update.

    this._notifyChanged(CHANGE_UPDATE, photo);
  },

  get selected() {
    return this._selected;
  },

  set selected(photo) {
    if (!this._ensurePhotoExists(photo))
      return;
    if (this._selected == photo)
      return;
    this._selected = photo;
    this._updateSelected();
  },

  get photos() {
    return this._photos;
  },

  _notifyChanged: function(changeType, parameter) {
    this._listeners.forEach(function(listener) {
      var [func, context] = listener;
      func.call(context, changeType, parameter);
    }, this);
  },

  addChangedListener: function(func, context) {
    this._listeners.push([func, context]);
  },

  removeChangedListener: function(func, context) {
    this._listeners = this._listeners.filter(hasFilter);
    function hasFilter(listener) {
      return listener[0] != func && listener[1] != context;
    }
  },

  _getUploadStream: function(photo, params) {
    const EOL = "\r\n";

    // Header stream.
    var header = "";

    for (let [name, value] in Iterator(params)) {
      header += "--" + BOUNDARY + EOL;
      header += "Content-disposition: form-data; name=\"" + name + "\"" + EOL + EOL;
      header += value;
      header += EOL;
    }

    header += "--" + BOUNDARY + EOL;
    header += "Content-disposition: form-data;name=\"filename\"; filename=\"" +
              photo.file.leafName + "\"" + EOL;
    // Apparently Facebook accepts binay content type and will sniff the file
    // for the correct image mime type.
    header += "Content-Type: application/octet-stream" + EOL;
    header += EOL;

    // Convert the stream to UTF-8, otherwise bad things happen.
    // See http://developer.taboca.com/cases/en/XMLHTTPRequest_post_utf-8/
    var converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"].
                    createInstance(Ci.nsIScriptableUnicodeConverter);
    converter.charset = "UTF-8";
    var headerStream = converter.convertToInputStream(header);

    var mis = Cc["@mozilla.org/io/multiplex-input-stream;1"].
              createInstance(Ci.nsIMultiplexInputStream);
    mis.appendStream(headerStream);

    // Image stream
    mis.appendStream(photo.resizedInputStream);

    // Ending stream
    var endingStream = new StringInputStream();
    var boundaryString = "\r\n--" + BOUNDARY + "--\r\n";
    endingStream.setData(boundaryString, boundaryString.length);
    mis.appendStream(endingStream);

    return mis;
  },

  _uploadPhoto: function(albumId, photo, onProgress, onComplete, onError) {
    LOG("Uploading photo: " + photo);

    var params = {};

    // method specific:
    params.method = "facebook.photos.upload";
    params.aid = albumId;
    if (photo.caption)
      params.caption = photo.caption;

    for (let [name, value] in Iterator(gFacebookService.getCommonParams())) {
        params[name] = value;
    }

    // Builds another array of params in the format accepted by generateSig()
    var paramsForSig = [];
    for (let [name, value] in Iterator(params)) {
      paramsForSig.push(name + "=" + value);
    }
    params.sig = gFacebookService.generateSig(paramsForSig);

    const RESTSERVER = 'http://api.facebook.com/restserver.php';

    var xhr = new XMLHttpRequest();

    function updateProgress(event) {
      if (!event.lengthComputable)
        return;
      onProgress((event.loaded / event.total) * 100);
    }

    // Progress handlers have to be set before calling open(). See
    // https://bugzilla.mozilla.org/show_bug.cgi?id=311425

    // The upload property is not available with Firefox 3.0
    if (xhr.upload) {
      xhr.upload.onprogress = updateProgress;
    }

    xhr.open("POST", RESTSERVER);
    xhr.setRequestHeader("Content-Type", "multipart/form-data; boundary=" + BOUNDARY);
    xhr.setRequestHeader("MIME-version", "1.0");

    xhr.onreadystatechange = function(event) {
      LOG("onreadstatechange " + xhr.readyState)
      if (xhr.readyState != 4)
        return;

      try {
        var data = JSON.parse(xhr.responseText);
      } catch(e) {
        onError("Failed to parse JSON");
        return;
      }
      // Duplicated from facebook.js::callMethod
      if (typeof data.error_code != "undefined") {
        onError("Server returned an error: " + data.error_msg);
        return;
      }
      onComplete(data.pid);
    }
    xhr.onerror = function(event) {
      onError("XMLHttpRequest error");
    }

    xhr.send(this._getUploadStream(photo, params));
  },

  _tagPhoto: function(photo, photoId, onComplete, onError) {
    if (photo.tags.length == 0) {
      onComplete()
      return;
    }
    var tagUploadObjects = [tag.getUploadObject() for each (tag in photo.tags)];

    gFacebookService.callMethod('facebook.photos.addTag',
      [
        "pid=" + photoId,
        "uid=" + gFacebookServiceUnwrapped.loggedInUser.id,
        "tags=" + JSON.stringify(tagUploadObjects)
      ],
      function(data) {
        if (data !== true) {
          onError("Error during tagging " + data);
          return;
        }
        onComplete();
      }
    );
  },

  _uploadAndTagPhoto: function(albumId, photo, onProgress, onComplete, onError) {
    this._uploadPhoto(albumId, photo, onProgress,
      function(photoId) { // onComplete callback
        PhotoSet._tagPhoto(photo, photoId, onComplete, onError);
      },
    onError);
  },

  upload: function(albumId, onProgress, onComplete, onError) {
    this._cancelled = false;
    var toUpload = this._photos;
    var total = toUpload.length;
    var index = 0;
    var self = this;

    var totalSizeBytes = [photo.sizeInBytes for each (photo in toUpload)].
                             reduce(function(a, b) a + b);
    var uploadedBytes = 0;

    function doUpload() {
      if (self._cancelled) {
        LOG("Upload cancelled");
        onComplete(true);
        return;
      }
      if (index == total) {
        LOG("PhotoSet.upload: index != total, How could that happen?");
        return;
      }
      var photo = toUpload[index];
      if (!photo) {
        LOG("PhotoSet.upload: no photo to upload, How could that happen?");
        return;
      }
      var photoSize = photo.sizeInBytes;

      try {
        self._uploadAndTagPhoto(albumId, photo,
          function(photoPercent) { // onProgress callback
            LOG("on progress from photo upload " + photoPercent);
            var donePercent = (uploadedBytes / totalSizeBytes) * 100;
            var photoRelativePercent = photoPercent * (photoSize / totalSizeBytes);
            onProgress(donePercent + photoRelativePercent);
          }, function() { // onComplete callback
            index++;
            uploadedBytes += photoSize;
            // Call progress here for Firefox 3.0 which won't get progress
            // notification during image upload.
            onProgress((uploadedBytes / totalSizeBytes) * 100)

            if (index == total) {
              onComplete(false);
              self.removeAll();
            } else {
              doUpload();
            }
          }, onError);
      } catch (e) {
        onError("Failure during upload: " + e);
      }
    }
    doUpload();
  },

  cancelUpload: function() {
    this._cancelled = true;
  }
};

/**
 * Manages the UI for displaying and manipulating the list of photos.
 */
var OverviewPanel = {
  _panelDoc: null,
  _photoContainer: null,

  init: function() {
    PhotoSet.addChangedListener(this.photosChanged, OverviewPanel);
    this._panelDoc = document.getElementById("overviewPanel").contentDocument;
    this._photoContainer = this._panelDoc.getElementById("photo-container");
  },

  uninit: function() {
    PhotoSet.removeChangedListener(this.photosChanged, OverviewPanel);
  },

  _iteratePhotoNodes: function(callback, context) {
    var node = this._photoContainer.firstChild;
    while (node) {
      var nextNode = node.nextSibling;
      if (node.nodeType == Node.ELEMENT_NODE &&
          node.className == "photobox" &&
          node.id != "photobox-template") {
        callback.call(context, node);
      }
      node = nextNode;
    }
  },

  _getNodeFromPhoto: function(photo) {
    var photoNode = null;
    this._iteratePhotoNodes(function(node) {
      if (node.photo == photo)
        photoNode = node;
    }, this);
    return photoNode;
  },

  _updateSelected: function(photo) {
    this._iteratePhotoNodes(function(node) {
      node.removeAttribute("selected");
    }, this);
    var photoNode = this._getNodeFromPhoto(photo);
    if (photoNode)
      photoNode.setAttribute("selected", "true");
  },

  photosChanged: function(changeType, parameter) {
    LOG("OverviewPanel::PhotosChanged " + changeType);

    if (changeType == CHANGE_SELECTED) {
      var selectedPhoto = parameter;
      this._updateSelected(selectedPhoto);
      return;
    }
    if (changeType == CHANGE_REMOVE_ALL) {
      this._iteratePhotoNodes(function(node) {
        this._photoContainer.removeChild(node);
      }, this);
      return;
    }
    if (changeType == CHANGE_REMOVE) {
      var toRemovePhoto = parameter;
      var photoNode = this._getNodeFromPhoto(toRemovePhoto);
      if (!photoNode) {
        LOG("Warning: can't find node of the photo to remove");
        return;
      }
      this._photoContainer.removeChild(photoNode);
      return;
    }
    if (changeType == CHANGE_ADD) {
      var toAddPhotos = parameter;
      var photoboxTemplate = this._panelDoc.getElementById("photobox-template");
      toAddPhotos.forEach(function(photo) {
        var newBox = photoboxTemplate.cloneNode(true);
        newBox.photo = photo;
        newBox.removeAttribute("id");
        newBox.getElementsByTagName("img")[0].src = photo.url;
        var filenameDiv = newBox.getElementsByClassName("filename")[0];
        filenameDiv.firstChild.data = photo.filename;
        photoboxTemplate.parentNode.insertBefore(newBox, photoboxTemplate);
      });
      return;
    }
  },

  _photoFromEvent: function(event) {
    event.stopPropagation();
    var node = event.target;
    while (node) {
      if (node.photo)
        return node.photo;
      node = node.parentNode;
    }
    return null;
  },

  selectPhoto: function(event) {
    var photo = this._photoFromEvent(event);
    if (!photo) {
      LOG("Error, photo not found");
      return;
    }
    PhotoSet.selected = photo;
  },

  removePhoto: function(event) {
    var photo = this._photoFromEvent(event);
    if (!photo) {
      LOG("Error, photo not found");
      return;
    }
    PhotoSet.remove(photo);
  }
};

/**
 * The panel that shows the selected photo where attributes can be edited.
 */
var EditPanel = {
  _editImageFrame: null,
  _imageElement: null,
  _highlightDiv: null,
  _highlightDivInside: null,
  _imageWidth: null,
  // Keep this in sync with the css in editimage.html
  IMAGE_BORDER_SIZE: 1,

  init: function() {
    PhotoSet.addChangedListener(this.photosChanged, EditPanel);
    this._editImageFrame = document.getElementById("editImageFrame");
    this._imageElement = this._editImageFrame.contentDocument
                             .getElementById("image");
    var self = this;
    this._imageElement.addEventListener("load", function(event) {
      self._onImageLoaded(event);
    }, false);
    this._highlightDiv = this._editImageFrame.contentDocument
                             .getElementById("tagHighlight");
    this._highlightDivInside = this._editImageFrame.contentDocument
                                   .getElementById("tagHighlightInside");
  },

  uninit: function() {
    PhotoSet.removeChangedListener(this.photosChanged, EditPanel);
  },

  _onImageLoaded: function(event) {
    this._imageWidth = event.target.width;
  },

  photosChanged: function(changeType, parameter) {
    LOG("EditPanel::PhotosChanged " + changeType);

    // Only care about update and selection change. If a photo is removed, we'll
    // always be notified of a selection change.
    if (changeType != CHANGE_UPDATE && changeType != CHANGE_SELECTED)
      return;

    var selectedPhoto = parameter;

    var filenameField = document.getElementById("editFilenameField");
    var sizeField = document.getElementById("editSizeField");
    var captionField = document.getElementById("editCaptionField");
    var tagList = document.getElementById("editTagList");
    var tagHelpBox = document.getElementById("editTagHelpBox");
    var removeTagsButton = document.getElementById("editRemoveTagsButton");

    this._imageElement.removeAttribute("hidden");
    this._hideTagHighlight();
    captionField.disabled = false;
    tagHelpBox.collapsed = false;
    removeTagsButton.disabled = true;
    while (tagList.hasChildNodes())
      tagList.removeChild(tagList.firstChild);

    if (!selectedPhoto) {
      this._imageWidth = null;
      this._imageElement.setAttribute("hidden", "true");
      this._imageElement.setAttribute("src", "about:blank");
      filenameField.value = "";
      sizeField.value = "";
      captionField.value = "";
      captionField.disabled = true;
      return;
    }

    this._imageElement.setAttribute("src", selectedPhoto.url);
    var filename = selectedPhoto.filename;
    const MAX_FILENAME_SIZE = 30;
    if (filename.length > MAX_FILENAME_SIZE)
      filename = filename.substring(0, MAX_FILENAME_SIZE) + "...";
    filenameField.value = filename;
    var sizeKb = selectedPhoto.sizeInBytes / 1024;
    var sizeString = PhotoUpload._stringBundle.getFormattedString("sizekb", [sizeKb.toFixed(0)])
    sizeField.value = sizeString;
    captionField.value = selectedPhoto.caption;

    if (selectedPhoto.tags.length == 0)
      return;

    tagHelpBox.collapsed = true;

    for each (let tag in selectedPhoto.tags) {
      var item = document.createElement("listitem");
      item.setAttribute("label", tag.label);
      item.tag = tag;
      tagList.appendChild(item);
    }
  },

  _showTagHighlight: function(tag) {
    var divX = this._imageElement.offsetLeft + this.IMAGE_BORDER_SIZE +
                   (tag.x * this._imageElement.clientWidth / 100);
    var divY = this._imageElement.offsetTop + this.IMAGE_BORDER_SIZE +
                   (tag.y * this._imageElement.clientHeight / 100);

    this._highlightDiv.style.left = divX + "px";
    this._highlightDiv.style.top = divY + "px";
    this._highlightDiv.removeAttribute("hidden");

    // The tag highlight box is 166x166 pixel large in the photo.php Facebook
    // page (the page users see when browsing photos).
    // The photo in the edit panel could be smaller than the photo in photo.php.
    // To make things more convenient, the tag highlight box is made
    // proportional to the highlight box size that would appear in photo.php.

    var highlightSize = [166, 166];
    if (this._imageWidth) {
      var ratio = this._imageWidth / PhotoSet.selected.facebookSize[0];
      highlightSize[0] *= ratio;
      highlightSize[1] *= ratio;
    }
    // This is the sum of the tagHighlight div border and tagHighlightInside border
    // Keep this in sync with the css of editimage.html.
    // TODO: use getComputedStyle to make this dynamic.
    const HIGHLIGHT_DIV_OFFSET_BASE = 9;

    var offsetLeft = HIGHLIGHT_DIV_OFFSET_BASE + highlightSize[0] / 2
    var offsetTop = HIGHLIGHT_DIV_OFFSET_BASE + highlightSize[1] / 2;

    this._highlightDiv.style.marginLeft = "-" + offsetLeft.toFixed(0) + "px";
    this._highlightDiv.style.marginTop = "-" + offsetTop.toFixed(0) + "px";

    this._highlightDivInside.style.width = highlightSize[0] + "px";
    this._highlightDivInside.style.height = highlightSize[1] + "px";
  },

  _hideTagHighlight: function() {
    this._highlightDiv.setAttribute("hidden", "true");
  },

  _updateRemoveTagsButton: function() {
    var tagList = document.getElementById("editTagList");
    var removeTagsButton = document.getElementById("editRemoveTagsButton");
    removeTagsButton.disabled = !tagList.selectedCount;
  },

  onTagSelect: function(event) {
    var tagList = event.target;
    this._updateRemoveTagsButton();
  },

  onMouseOver: function(event) {
    if (event.target.nodeName != "listitem")
      return;
    var tag = event.target.tag;
    if (!tag)
      return;
    this._showTagHighlight(tag);
  },

  onMouseOut: function(event) {
    this._hideTagHighlight();
  },

  onRemoveSelectedTags: function(event) {
    var tagList = document.getElementById("editTagList");
    var selectedPhoto = PhotoSet.selected;
    if (tagList.selectedCount == 0 || !selectedPhoto)
      return;

    for each (let item in tagList.selectedItems) {
      var tag = item.tag;
      selectedPhoto.removeTag(tag);
    }
    PhotoSet.update(selectedPhoto);

    this._updateRemoveTagsButton();
  },

  onCaptionInput: function(event) {
    var selectedPhoto = PhotoSet.selected;
    if (!selectedPhoto)
      return;

    selectedPhoto.caption = event.target.value;
    PhotoSet.update(selectedPhoto);
  },

  onPhotoClick: function(event) {
    var selectedPhoto = PhotoSet.selected;
    if (!selectedPhoto)
      return;

    var offsetXInImage = event.clientX - this._imageElement.offsetLeft - this.IMAGE_BORDER_SIZE;
    var offsetYInImage = event.clientY - this._imageElement.offsetTop - this.IMAGE_BORDER_SIZE;
    var offsetXPercent = (offsetXInImage / this._imageElement.clientWidth * 100).toFixed(0);
    var offsetYPercent = (offsetYInImage / this._imageElement.clientHeight * 100).toFixed(0);
    offsetXPercent = Math.min(Math.max(offsetXPercent, 0), 100);
    offsetYPercent = Math.min(Math.max(offsetYPercent, 0), 100);

    // temporary tag for showing highlight while the tag editing popup is shown.
    var tempTag = new Tag("tempTag", offsetXPercent, offsetYPercent);
    this._showTagHighlight(tempTag);

    var fbUsers = gFacebookService.getFriends({});
    var friends = [];
    // Add logged in user so she can tag herself.
    var ownUserName = PhotoUpload._stringBundle.getString("ownUserName");
    ownUserName = ownUserName.replace("%USERNAME%",
                                      gFacebookService.loggedInUser.name);
    friends.push(new Friend(ownUserName, gFacebookService.loggedInUser.id));

    for each (var fbUser in fbUsers) {
      friends.push(new Friend(fbUser.name, fbUser.id));
    }

    var dialogParams = {
      offsetXPercent: offsetXPercent,
      offsetYPercent: offsetYPercent,
      friends: friends,
      TextTag: TextTag,
      PeopleTag: PeopleTag
    };
    openDialog("chrome://facebook/content/photoupload/taggingdialog.xul", null,
               "chrome,modal,centerscreen,titlebar,dialog=yes", dialogParams);
    this._hideTagHighlight();
    if (!dialogParams.tag)
      return;

    var selectedPhoto = PhotoSet.selected;
    if (!selectedPhoto)
      return;
    selectedPhoto.addTag(dialogParams.tag);
    PhotoSet.update(selectedPhoto);
  }
};

var PhotoDNDObserver = {
  getSupportedFlavours : function () {
    var flavours = new FlavourSet();
    flavours.appendFlavour("text/x-moz-url");
    flavours.appendFlavour("application/x-moz-file",  "nsIFile");
    return flavours;
  },

  _getFileFromDragSession: function (session, position) {
    var fileData = { };
    var ios = Cc["@mozilla.org/network/io-service;1"].
              getService(Ci.nsIIOService);
    // if this fails we do not have valid data to drop
    try {
      var xfer = Cc["@mozilla.org/widget/transferable;1"].
                 createInstance(Ci.nsITransferable);
      xfer.addDataFlavor("text/x-moz-url");
      xfer.addDataFlavor("application/x-moz-file", "nsIFile");
      session.getData(xfer, position);

      var flavour = { }, data = { }, length = { };
      xfer.getAnyTransferData(flavour, data, length);
      var selectedFlavour = this.getSupportedFlavours().flavourTable[flavour.value];
      var xferData = new FlavourData(data.value, length.value, selectedFlavour);

      var fileURL = transferUtils.retrieveURLFromData(xferData.data,
                                                      xferData.flavour.contentType);
      var file = ios.newURI(fileURL, null, null).QueryInterface(Ci.nsIFileURL).file;
    } catch (e) {
      LOG("Exception while getting drag data: " + e);
      return null;
    }
    return file;
  },

  onDrop: function (event, dropdata, session) {
    var count = session.numDropItems;
    var files = [];
    for (var i = 0; i < count; ++i) {
      var file = this._getFileFromDragSession(session, i);
      if (file)
        files.push(file);
    }
    PhotoSet.add([new Photo(f) for each (f in files)]);
  }
};

const NEW_ALBUM = 0;
const EXISTING_ALBUM = 1;

const PROFILE_PICTURES_URL_ALBUM_ID = "4294967293"; // -3 in two's complement 32bit integer.

const POST_UPLOAD_ASKUSER = 0;
const POST_UPLOAD_OPENALBUM = 1;
const POST_UPLOAD_STAYHERE = 2;

const UPLOAD_CANCELLED = 0;
const UPLOAD_COMPLETE = 1;
const UPLOAD_ERROR = 2;

/**
 * Manages the Photo upload window.
 */
var PhotoUpload = {
  _uploadCancelled: false,
  _uploadStatus: null,
  _uploadStatusDeck: null,
  _uploadProgress: null,
  _uploadBroadcaster: null,
  _observerService: null,
  _quitObserver: null,

  get _stringBundle() {
    delete this._stringBundle;
    return this._stringBundle = document.getElementById("facebookStringBundle");
  },

  _url: function(spec) {
    var ios = Cc["@mozilla.org/network/io-service;1"].
              getService(Ci.nsIIOService);
    return ios.newURI(spec, null, null);
  },

  init: function() {
    var self = this;

    OverviewPanel.init();
    EditPanel.init();
    PhotoSet.addChangedListener(this.photosChanged, PhotoUpload);

    this._uploadStatus = document.getElementById("uploadStatus")
    this._uploadStatusDeck = document.getElementById("uploadStatusDeck");
    this._uploadProgress = document.getElementById("uploadProgress");
    this._uploadBroadcaster = document.getElementById("uploadBroadcaster");

    // Observe when the application wants to quit
    this._observerService = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
    this._observerService.addObserver(QuitObserver, "quit-application-requested", false);

    // New album default name
    /*
    var defaultAlbumName = this._stringBundle.getString("defaultAlbumName");
    defaultAlbumName = defaultAlbumName.replace("%DATE%", new Date().toLocaleDateString());
    document.getElementById("albumName").value = defaultAlbumName;
   */

    // When closing the login dialog, the loggedInUser property is not set
    // immediatly. Wait a few moment before asking the user to log in.

    const LOGGED_IN_POLL_TIMEOUT = 1000;
    const NUM_TRIES = 5;

    var self = this;
    var tries = 0;

    function checkIfLoggedIn() {
      LOG("Checking if user is logged in, try " + (tries + 1) + " / " + NUM_TRIES);
      tries++;
      if (tries == NUM_TRIES) {
        alert(self._stringBundle.getString("mustLoginDialog"));
        window.close();
        return;
      }
      if (!gFacebookServiceUnwrapped.loggedInUser) {
        LOG("not logged in, retrying");
        setTimeout(checkIfLoggedIn, LOGGED_IN_POLL_TIMEOUT);
        return;
      }
      LOG("logged in");
      self._fillAlbumList(function() { // onComplete callback
        self._checkPhotoUploadPermission();
      });
    }

    checkIfLoggedIn();
  },

  uninit: function() {
    var self = this;
    OverviewPanel.uninit();
    EditPanel.uninit();
    PhotoSet.removeChangedListener(this.photosChanged, PhotoUpload);

    this._observerService.removeObserver(QuitObserver, "quit-application-requested");

    if (this.getAlbumSelectionMode() == EXISTING_ALBUM) {
      var albumsList = document.getElementById("albumsList");
      if (!albumsList.selectedItem)
        return;
      var albumId = albumsList.selectedItem.getAttribute("albumid");
      document.getElementById("albumsList").setAttribute("lastalbumid", albumId);
    }
    document.persist("albumsList", "lastalbumid");
  },

  /**
   * canClose:
   * returns true if there are no uploads
   * returns true if there ARE uploads, but user wants to cancel them
   * returns false if there ARE uploads, but user wants to let them finish
   */
  canClose: function() {
    var self = this;
    var isUploading = (this._uploadProgress.value > 0);

    if (!isUploading) {
      return true;
    }

    var showConfirmCloseWhileUploadingPrompt = function() {
      const IPS = Ci.nsIPromptService;
      var ps = Cc["@mozilla.org/embedcomp/prompt-service;1"].getService(IPS);

      var dummy = {value: false};

      var flags = IPS.BUTTON_POS_0 * IPS.BUTTON_TITLE_IS_STRING +
        IPS.BUTTON_POS_1 * IPS.BUTTON_TITLE_IS_STRING;

      var ret = ps.confirmEx(
          window,
          self._stringBundle.getString("showConfirmCloseWhileUploadingPromptTitle"),
          self._stringBundle.getString("showConfirmCloseWhileUploadingPromptText"),
          flags,
          self._stringBundle.getString("showConfirmCloseWhileUploadingPromptLetUploadFinish"),
          self._stringBundle.getString("showConfirmCloseWhileUploadingPromptCancelUploadAndClose"),
          null,
          null,
          dummy
          );

      return (ret == 0);
    };

    if (showConfirmCloseWhileUploadingPrompt()) {
      return false;
    }

    LOG("canClose() : user wants to continue with window close, will cancel uploads");

    self.cancelUpload();

    return true;
  },

  _fillAlbumList: function(onComplete) {
    gFacebookService.callMethod('facebook.photos.getAlbums',
      ["uid=" + gFacebookServiceUnwrapped.loggedInUser.id],
      function(albums) {
        // Remove the "Profile Pictures" album from the list, it's a special
        // album and uploading to this album generates errors.
        albums = albums.filter(function(a) {
          var urlAlbumId = PhotoUpload._albumIdToUrlAlbumId(a.aid);
          return urlAlbumId != PROFILE_PICTURES_URL_ALBUM_ID;
        });

        if (albums.length == 0) {
          LOG("No albums");
          var newAlbumRadio = document.getElementById("newAlbumRadio");
          document.getElementById("albumSelectionGroup").selectedItem = newAlbumRadio;
          PhotoUpload.onAlbumSelectionModeChange()
          document.getElementById("existingAlbumRadio").disabled = true;
          return;
        }
        var albumsPopup = document.getElementById("albumsPopup");
        var lastAlbumId = document.getElementById("albumsList")
                                  .getAttribute("lastalbumid");
        var selectedItem;
        for each (var album in albums) {
          var menuitem = document.createElement("menuitem");
          menuitem.setAttribute("label", album.name);
          menuitem.setAttribute("albumid", album.aid);
          if (album.aid == lastAlbumId)
            selectedItem = menuitem;
          LOG("Album name: " + album.name + " album id: " + album.aid);
          albumsPopup.appendChild(menuitem);
        }
        var albumsList = document.getElementById("albumsList");
        if (selectedItem) {
          albumsList.selectedItem = selectedItem;
        } else {
          albumsList.selectedIndex = 0;
        }
        document.getElementById("existingAlbumPanel").className = "";
        onComplete();
      }
    );
  },

  _checkPhotoUploadPermission: function() {
    LOG("Checking photo upload permission");
    const PERM = "photo_upload";

    var self = this;
    gFacebookService.callMethod('facebook.users.hasAppPermission',
      ['ext_perm=' + PERM],
      function(data) {
        LOG("facebook.users.hasAppPermission returns: " + data + " ts " + data.toString());
        // It previously returned the '1' string, but this changed to 'true'
        // in mid April 2009. Check both in case it changes again.
        if ('1' == data.toString() || 'true' == data.toString()) {
          LOG("photo upload is authorized");
          return;
        }

        let promptTitle = self._stringBundle.getString("allowUploadTitle");
        let promptMessage = self._stringBundle.getString("allowUploadMessage");
        let openAuthorize = self._stringBundle.getString("openAuthorizePage");

        const IPS = Ci.nsIPromptService;
        let ps = Cc["@mozilla.org/embedcomp/prompt-service;1"].getService(IPS);
        let rv = ps.confirmEx(window, promptTitle, promptMessage,
                              (IPS.BUTTON_TITLE_IS_STRING * IPS.BUTTON_POS_0) +
                              (IPS.BUTTON_TITLE_CANCEL * IPS.BUTTON_POS_1),
                              openAuthorize, null, null, null, {value: 0});

        if (rv != 0)
          return;
        var authorizeUrl = "http://www.facebook.com/authorize.php?api_key=" +
                           gFacebookService.apiKey +"&v=1.0&ext_perm=" + PERM;
        Application.activeWindow.open(self._url(authorizeUrl)).focus();
        window.close();
      }
    );
  },

  photosChanged: function(changeType, parameter) {
    document.getElementById("uploadButton").disabled = PhotoSet.photos.length == 0;
    document.getElementById("removeAllButton").disabled = PhotoSet.photos.length == 0;
  },

  getAlbumSelectionMode: function() {
    var albumSelectionGroup = document.getElementById("albumSelectionGroup");
    var existingAlbumRadio = document.getElementById("existingAlbumRadio");
    var newAlbumRadio = document.getElementById("newAlbumRadio");

    if (albumSelectionGroup.selectedItem == existingAlbumRadio)
      return EXISTING_ALBUM;
    if (albumSelectionGroup.selectedItem == newAlbumRadio)
      return NEW_ALBUM;

    throw "Unknown album selection mode";
  },

  onAlbumSelectionModeChange: function() {
    var albumSelectionDeck = document.getElementById("albumSelectionDeck");
    var selectionMode = this.getAlbumSelectionMode();

    if (selectionMode == EXISTING_ALBUM) {
      albumSelectionDeck.selectedPanel =
        document.getElementById("existingAlbumPanel");
    } else if (selectionMode == NEW_ALBUM) {
      albumSelectionDeck.selectedPanel =
        document.getElementById("newAlbumPanel");
    }
  },

  addPhotos: function() {
    var fp = Cc["@mozilla.org/filepicker;1"].
             createInstance(Ci.nsIFilePicker);
    var aTitle = "";
    try {
      aTitle = this._stringBundle.getString("filePickerTitle");
    }
    catch(e) {
      aTitle = "Select Photos";
      //LOG("Filepicker title failure: "+e);
    }
    fp.init(window, aTitle,
            Ci.nsIFilePicker.modeOpenMultiple);
    fp.appendFilters(Ci.nsIFilePicker.filterImages);
    if (fp.show() != Ci.nsIFilePicker.returnCancel) {
      var photos = [];
      var filesEnum = fp.files;
      while (filesEnum.hasMoreElements()) {
        photos.push(new Photo(filesEnum.getNext()));
      }
      PhotoSet.add(photos);
    }
  },

  removeAllPhotos: function() {
    PhotoSet.removeAll();
  },

  cancelUpload: function() {
    this._uploadCancelled = true;
    PhotoSet.cancelUpload();
  },

  /**
   * Converts the album id that is used in the Facebook API to the album id
   * that is used in the aid GET parameter of the editalbum.php page.
   */
  _albumIdToUrlAlbumId: function(albumId) {
    // the url album id is the least significant 32 bits of the api-generated
    // album id, the user id is the most significant 32 bits.

    // Javascript Number are 64bit floating point. The albumid is a 64bit integer.
    // That number is too big to be handled directly without loss of precision,
    // so we use an external library for calculation.
    var id = new BigInteger(albumId, 10);
    var mask = new BigInteger("ffffffff", 16);
    var urlAlbumId = id.and(mask);
    return urlAlbumId.toString(10);
  },

  _showUploadCompleteNotification: function(albumId) {
    try {
      let upText = this._stringBundle.getString("uploadCompleteAlert");
      let aid = "aid=" + this._albumIdToUrlAlbumId(albumId) + "&";
      let postUploadUrl = "http://www.facebook.com/editalbum.php?" + aid + "org=1";
      gFacebookService.showPopup('upload.complete', 'chrome://facebook/skin/photo.gif',
                                 upText, postUploadUrl);
    }
    catch(e) {
      LOG("Error showing upload complete alert: " + e);
    }
  },

  _maybeOpenAlbumPage: function(albumId) {
    var prefSvc = Cc['@mozilla.org/preferences-service;1'].getService(Ci.nsIPrefBranch);
    var postUploadAction = prefSvc.getIntPref("extensions.facebook.postuploadaction");

    if (postUploadAction == POST_UPLOAD_ASKUSER) {
      let promptTitle = this._stringBundle.getString("uploadCompleteTitle");
      let promptMessage = this._stringBundle.getString("uploadCompleteMessage");
      let checkboxLabel = this._stringBundle.getString("rememberDecision");
      let goToAlbum = this._stringBundle.getString("goToAlbum");
      let stayHere = this._stringBundle.getString("stayHere");

      const IPS = Ci.nsIPromptService;
      let ps = Cc["@mozilla.org/embedcomp/prompt-service;1"].getService(IPS);
      let remember = { value: false };
      let rv = ps.confirmEx(window, promptTitle, promptMessage,
                            (IPS.BUTTON_TITLE_IS_STRING * IPS.BUTTON_POS_0) +
                            (IPS.BUTTON_TITLE_IS_STRING * IPS.BUTTON_POS_1),
                            goToAlbum, stayHere, null, checkboxLabel, remember);

      postUploadAction = rv == 0 ? POST_UPLOAD_OPENALBUM : POST_UPLOAD_STAYHERE;
      if (remember.value) {
        prefSvc.setIntPref("extensions.facebook.postuploadaction", postUploadAction);
      }
    }
    if (postUploadAction == POST_UPLOAD_STAYHERE)
      return;

    if (postUploadAction == POST_UPLOAD_OPENALBUM) {
      var aid = "";
      aid = "aid=" + this._albumIdToUrlAlbumId(albumId) + "&";
      Application.activeWindow.open(
        this._url("http://www.facebook.com/editalbum.php?" + aid + "org=1")).focus();
      window.close();
    }
  },

  _createAlbum: function() {
    var albumName = document.getElementById("albumName").value;
    if (!albumName) {
      // TODO: would be better to disable the Upload button in that case.
      alert("Album name shouldn't be empty");
      this._uploadComplete(UPLOAD_CANCELLED);
      return;
    }
    var albumLocation = document.getElementById("albumLocation").value;
    var albumDescription = document.getElementById("albumDescription").value;
    var albumVisibility = document.getElementById("albumVisibility")
                                  .selectedItem.value;

    var params = [
      "uid=" + gFacebookServiceUnwrapped.loggedInUser.id,
      "name=" + albumName,
      "visible=" + albumVisibility
    ];
    if (albumLocation)
      params.push("location=" + albumLocation);
    if (albumDescription)
      params.push("description=" + albumDescription);

    gFacebookService.callMethod('facebook.photos.createAlbum',
      params,
      function(data) {
        if (!data.aid) {
          LOG("Error while creating album");
          self._uploadComplete(UPLOAD_ERROR, null, "Error while creating album");
          return;
        }
        PhotoUpload._uploadToAlbum(data.aid)
      }
    );
  },

  /**
   * Starts the upload process. This is the public method that should be
   * called from the UI.
   */
  upload: function() {
    if (PhotoSet.photos.length == 0) {
      // This shouldn't happen (button is disabled when there are no photos).
      return;
    }
    // TODO: store albumId in a field instead of passing it around.

    this._uploadStatusDeck.selectedIndex = 1;
    this._uploadBroadcaster.setAttribute("disabled", "true");
    this._uploadStatus.className = "upload-status";
    this._uploadStatus.value = "";

    var selectionMode = this.getAlbumSelectionMode();
    if (selectionMode == NEW_ALBUM) {
      this._createAlbum();
    } else if (selectionMode == EXISTING_ALBUM) {
      var albumsList = document.getElementById("albumsList");
      if (!albumsList.selectedItem) {
          this._uploadComplete(UPLOAD_ERROR, null, "Unexpected state");
        return;
      }
      this._uploadToAlbum(albumsList.selectedItem.getAttribute("albumid"));
    } else {
      throw "Unexpected selection mode";
    }
  },

  /**
   * Should be called when the upload is complete or cancelled in order to
   * restore the UI / show error messages / or open the album page.
   */
  _uploadComplete: function(status, albumId, errorMessage) {
    this._uploadCancelled = false;
    this._uploadProgress.value = 0;
    this._uploadBroadcaster.setAttribute("disabled", "false");
    this._uploadStatusDeck.selectedIndex = 0;

    if (status == UPLOAD_CANCELLED) {
      this._uploadStatus.value = this._stringBundle.getString("uploadCancelled");
    } else if (status == UPLOAD_COMPLETE) {
      this._uploadStatus.value = this._stringBundle.getString("uploadComplete");
      this._showUploadCompleteNotification(albumId);
      this._maybeOpenAlbumPage(albumId);
    } else if (status == UPLOAD_ERROR) {
      alert(this._stringBundle.getString("uploadFailedAlert") + " " + errorMessage);
      this._uploadStatus.className += " error";
      this._uploadStatus.value = this._stringBundle.getString("uploadFailedStatus") +
                                 " " + errorMessage;
    } else {
      LOG("Unknown upload status: " + status);
    }
  },

  /**
   * Second phase of the upload process. This is called from upload() and is
   * in a separate method in order to be called asynchronously when creating
   * a new album
   */
  _uploadToAlbum: function(albumId) {
    if (this._uploadCancelled) {
      this._uploadComplete(UPLOAD_CANCELLED, albumId);
      return;
    }

    var self = this;
    PhotoSet.upload(albumId,
      function(percent) { // onProgress callback
        LOG("Got progress " + percent);
        self._uploadProgress.value = percent;
      }, function(cancelled) { // onComplete callback
        self._uploadComplete(cancelled ? UPLOAD_CANCELLED : UPLOAD_COMPLETE, albumId);
      }, function(message) { // onError callback
        self._uploadComplete(UPLOAD_ERROR, null, message);
    });
  }
};
