import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AdminLayout } from "@/components/layouts/admin-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { ObjectUploader } from "@/components/ObjectUploader";
import type { Document, User } from "@shared/schema";
import {
  Search,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  File,
  Download,
  Trash2,
  MoreVertical,
  Eye,
  Filter,
  Users,
  Globe,
  Lock,
  FolderIcon,
  Upload,
  Plus,
  ExternalLink,
} from "lucide-react";

function getFileIcon(mimeType?: string | null, fileType?: string | null) {
  const type = mimeType || fileType || "";
  if (type.startsWith("image/")) return <FileImage className="h-4 w-4" />;
  if (type.startsWith("video/")) return <FileVideo className="h-4 w-4" />;
  if (type.startsWith("audio/")) return <FileAudio className="h-4 w-4" />;
  if (type.includes("pdf") || type.includes("document") || type.includes("text"))
    return <FileText className="h-4 w-4" />;
  return <File className="h-4 w-4" />;
}

function formatFileSize(bytes?: number | null): string {
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(date?: Date | string | null): string {
  if (!date) return "-";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getVisibilityIcon(visibility: string) {
  switch (visibility) {
    case "PUBLIC":
      return <Globe className="h-3 w-3" />;
    case "PRIVATE":
      return <Lock className="h-3 w-3" />;
    default:
      return <Users className="h-3 w-3" />;
  }
}

export default function AdminDocuments() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [visibilityFilter, setVisibilityFilter] = useState<string>("");
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [viewingDocument, setViewingDocument] = useState<Document | null>(null);
  const [showViewDialog, setShowViewDialog] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [viewBlobUrl, setViewBlobUrl] = useState<string | null>(null);
  const [uploadedFileInfo, setUploadedFileInfo] = useState<{
    url: string;
    name: string;
    size: number;
    mimeType: string;
  } | null>(null);
  const [newDocument, setNewDocument] = useState({
    name: "",
    description: "",
    category: "RESOURCE",
    visibility: "PUBLIC",
    isTemplate: false,
    trackId: "",
    cohortId: "",
  });

  const { data: documents, isLoading } = useQuery<Document[]>({
    queryKey: ["/api/admin/documents", categoryFilter, visibilityFilter, searchQuery],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (categoryFilter) params.set("category", categoryFilter);
      if (visibilityFilter) params.set("visibility", visibilityFilter);
      if (searchQuery) params.set("search", searchQuery);
      const res = await fetch(`/api/admin/documents?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch documents");
      return res.json();
    },
  });

  // Tracks and cohorts power the scope selectors on the upload dialog. Without a
  // concrete trackId/cohortId, TRACK/COHORT documents are invisible to members
  // (the read filter requires the id to match a membership).
  const { data: tracks } = useQuery<{ id: string; name: string; slug: string }[]>({
    queryKey: ["/api/tracks"],
    queryFn: async () => {
      const res = await fetch(`/api/tracks`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch tracks");
      return res.json();
    },
  });

  const { data: cohorts } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["/api/cohorts"],
    queryFn: async () => {
      const res = await fetch(`/api/cohorts`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch cohorts");
      return res.json();
    },
  });

  const deleteDocumentMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/documents/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/documents"] });
      toast({ title: "Document deleted successfully" });
      setShowDeleteDialog(false);
      setSelectedDocument(null);
    },
    onError: () => {
      toast({ title: "Failed to delete document", variant: "destructive" });
    },
  });

  const createDocumentMutation = useMutation({
    mutationFn: async (data: {
      name: string;
      description: string;
      category: string;
      visibility: string;
      isTemplate: boolean;
      fileUrl: string;
      fileSize: number;
      mimeType: string;
      trackId?: string;
      cohortId?: string;
    }) => {
      return apiRequest("POST", "/api/documents", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/documents"] });
      toast({ title: "Document created successfully" });
      setShowUploadDialog(false);
      setUploadedFileInfo(null);
      setNewDocument({
        name: "",
        description: "",
        category: "RESOURCE",
        visibility: "PUBLIC",
        isTemplate: false,
        trackId: "",
        cohortId: "",
      });
    },
    onError: () => {
      toast({ title: "Failed to create document", variant: "destructive" });
    },
  });

  const handleCreateDocument = () => {
    if (!uploadedFileInfo) {
      toast({ title: "Please upload a file first", variant: "destructive" });
      return;
    }
    if (!newDocument.name.trim()) {
      toast({ title: "Please enter a document name", variant: "destructive" });
      return;
    }
    if (newDocument.visibility === "TRACK" && !newDocument.trackId) {
      toast({ title: "Please select a track", description: "Track-scoped documents must be assigned to a track.", variant: "destructive" });
      return;
    }
    if (newDocument.visibility === "COHORT" && !newDocument.cohortId) {
      toast({ title: "Please select a cohort", description: "Cohort-scoped documents must be assigned to a cohort.", variant: "destructive" });
      return;
    }
    createDocumentMutation.mutate({
      name: newDocument.name,
      description: newDocument.description,
      category: newDocument.category,
      visibility: newDocument.visibility,
      isTemplate: newDocument.isTemplate,
      fileUrl: uploadedFileInfo.url,
      fileSize: uploadedFileInfo.size,
      mimeType: uploadedFileInfo.mimeType,
      // Only send the scope id relevant to the chosen visibility.
      trackId: newDocument.visibility === "TRACK" ? newDocument.trackId : undefined,
      cohortId: newDocument.visibility === "COHORT" ? newDocument.cohortId : undefined,
    });
  };

  const downloadDocument = async (doc: Document) => {
    try {
      // Use fetch with credentials to get the file as a blob
      const response = await fetch(`/api/documents/${doc.id}/download`, {
        credentials: "include",
      });
      
      if (!response.ok) {
        // Try to get a more specific error message
        try {
          const errorData = await response.json();
          if (response.status === 404 && errorData.message?.includes("not found in storage")) {
            toast({ 
              title: "File not available", 
              description: "This file may need to be re-uploaded. The file was uploaded in a different environment.",
              variant: "destructive" 
            });
            return;
          }
        } catch {
          // Ignore JSON parsing errors
        }
        throw new Error("Download failed");
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.name + (doc.mimeType === "application/pdf" ? ".pdf" : "");
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      toast({ title: "Document downloaded successfully" });
    } catch {
      toast({ title: "Failed to download document", variant: "destructive" });
    }
  };

  const openDocumentViewer = async (doc: Document) => {
    setViewingDocument(doc);
    setViewError(null);
    setViewLoading(true);
    setViewBlobUrl(null);
    setShowViewDialog(true);

    try {
      const response = await fetch(`/api/documents/${doc.id}/view`, { credentials: 'include' });
      if (!response.ok) {
        let errorMsg = `Failed to load document (${response.status})`;
        try {
          const errorData = await response.json();
          if (errorData.message) errorMsg = errorData.message;
        } catch {}
        throw new Error(errorMsg);
      }
      const arrayBuffer = await response.arrayBuffer();
      const contentType = response.headers.get('Content-Type') || doc.mimeType || 'application/octet-stream';
      const blob = new Blob([arrayBuffer], { type: contentType });
      const url = URL.createObjectURL(blob);
      setViewBlobUrl(url);
      setViewLoading(false);
    } catch (err: any) {
      setViewLoading(false);
      setViewError(err.message || "Failed to load document preview.");
    }
  };

  const openDocumentInNewTab = () => {
    if (viewBlobUrl) {
      window.open(viewBlobUrl, '_blank');
    }
  };

  const stats = {
    total: documents?.length || 0,
    public: documents?.filter(d => d.visibility === "PUBLIC").length || 0,
    templates: documents?.filter(d => d.isTemplate).length || 0,
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Document Management</h1>
          <p className="text-muted-foreground">Manage all documents uploaded to the platform</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Documents</CardTitle>
              <FileText className="h-5 w-5 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold" data-testid="text-total-documents">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Public Documents</CardTitle>
              <Globe className="h-5 w-5 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold" data-testid="text-public-documents">{stats.public}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Templates</CardTitle>
              <FolderIcon className="h-5 w-5 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold" data-testid="text-templates">{stats.templates}</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <CardTitle>All Documents</CardTitle>
                <CardDescription>View and manage all documents on the platform</CardDescription>
              </div>
              <Button onClick={() => setShowUploadDialog(true)} data-testid="button-upload-document">
                <Plus className="h-4 w-4 mr-2" />
                Upload Document
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-4 mb-6">
              <div className="relative flex-1 min-w-[200px] max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search documents..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                  data-testid="input-admin-search"
                />
              </div>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="w-[150px]" data-testid="select-admin-category">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All Categories</SelectItem>
                  <SelectItem value="TEMPLATE">Template</SelectItem>
                  <SelectItem value="AGREEMENT">Agreement</SelectItem>
                  <SelectItem value="RESOURCE">Resource</SelectItem>
                  <SelectItem value="SUBMISSION">Submission</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
              <Select value={visibilityFilter} onValueChange={setVisibilityFilter}>
                <SelectTrigger className="w-[150px]" data-testid="select-admin-visibility">
                  <SelectValue placeholder="Visibility" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All Visibility</SelectItem>
                  <SelectItem value="PUBLIC">Public</SelectItem>
                  <SelectItem value="COHORT">Cohort Only</SelectItem>
                  <SelectItem value="TRACK">Track Only</SelectItem>
                  <SelectItem value="MATCH">Match Only</SelectItem>
                  <SelectItem value="PRIVATE">Private</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {isLoading ? (
              <div className="space-y-4">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : documents && documents.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Document</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Visibility</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Downloads</TableHead>
                      <TableHead>Uploaded</TableHead>
                      <TableHead className="w-[80px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {documents.map((doc) => (
                      <TableRow key={doc.id} data-testid={`row-admin-doc-${doc.id}`}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="p-1.5 bg-muted rounded">
                              {getFileIcon(doc.mimeType, doc.fileType)}
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium truncate max-w-[200px]" data-testid={`text-doc-name-${doc.id}`}>
                                {doc.name}
                              </p>
                              {doc.description && (
                                <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                                  {doc.description}
                                </p>
                              )}
                            </div>
                            {doc.isTemplate && (
                              <Badge variant="outline" className="text-xs">
                                Template
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-xs">
                            {doc.category}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs flex items-center gap-1 w-fit">
                            {getVisibilityIcon(doc.visibility || "PRIVATE")}
                            {doc.visibility}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatFileSize(doc.fileSize)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {doc.downloadCount || 0}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatDate(doc.createdAt)}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" data-testid={`button-actions-${doc.id}`}>
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => openDocumentViewer(doc)} data-testid={`button-view-doc-${doc.id}`}>
                                <Eye className="h-4 w-4 mr-2" />
                                View
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => downloadDocument(doc)} data-testid={`button-download-doc-${doc.id}`}>
                                <Download className="h-4 w-4 mr-2" />
                                Download
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => {
                                  setSelectedDocument(doc);
                                  setShowDeleteDialog(true);
                                }}
                                className="text-destructive"
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-12">
                <FileText className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
                <h3 className="text-lg font-medium mb-2">No documents found</h3>
                <p className="text-muted-foreground">
                  {searchQuery || categoryFilter || visibilityFilter
                    ? "Try adjusting your filters"
                    : "Documents will appear here once users upload them"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Document</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{selectedDocument?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)} data-testid="button-cancel-delete">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => selectedDocument && deleteDocumentMutation.mutate(selectedDocument.id)}
              disabled={deleteDocumentMutation.isPending}
              data-testid="button-confirm-delete"
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showViewDialog} onOpenChange={(open) => {
        setShowViewDialog(open);
        if (!open) {
          if (viewBlobUrl) {
            URL.revokeObjectURL(viewBlobUrl);
            setViewBlobUrl(null);
          }
          setViewingDocument(null);
          setViewLoading(false);
          setViewError(null);
        }
      }}>
        <DialogContent className="max-w-4xl h-[85vh] flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-2 flex-shrink-0">
            <div className="flex items-center justify-between gap-4 pr-8">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="p-2 bg-muted rounded-md flex-shrink-0">
                  {viewingDocument && getFileIcon(viewingDocument.mimeType, viewingDocument.fileType)}
                </div>
                <div className="min-w-0">
                  <DialogTitle className="truncate" data-testid="text-admin-viewer-title">
                    {viewingDocument?.name}
                  </DialogTitle>
                  <DialogDescription className="truncate">
                    {viewingDocument && formatFileSize(viewingDocument.fileSize)}
                    {viewingDocument?.category && ` · ${viewingDocument.category}`}
                  </DialogDescription>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => viewingDocument && downloadDocument(viewingDocument)}
                data-testid="button-admin-viewer-download"
              >
                <Download className="h-4 w-4 mr-2" />
                Download
              </Button>
            </div>
          </DialogHeader>
          <div className="flex-1 min-h-0 px-6 pb-6 relative">
            {viewLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted-foreground border-t-transparent" />
              </div>
            )}
            {viewError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80 gap-3 z-10">
                <p className="text-destructive font-medium">{viewError}</p>
                <Button variant="outline" onClick={() => viewingDocument && downloadDocument(viewingDocument)}>
                  <Download className="h-4 w-4 mr-2" />
                  Download Instead
                </Button>
              </div>
            )}
            {viewingDocument && viewBlobUrl && (
              viewingDocument.mimeType === "application/pdf" ? (
                <div className="w-full h-full flex flex-col gap-2">
                  <iframe
                    src={viewBlobUrl + "#toolbar=1"}
                    className="w-full flex-1 rounded-md border"
                    title={viewingDocument.name}
                    data-testid="iframe-admin-document-viewer"
                  />
                  <div className="flex items-center justify-center gap-2 flex-shrink-0">
                    <Button variant="outline" size="sm" onClick={openDocumentInNewTab} data-testid="button-admin-open-new-tab">
                      <ExternalLink className="h-4 w-4 mr-2" />
                      Open in New Tab
                    </Button>
                  </div>
                </div>
              ) : viewingDocument.mimeType?.startsWith("image/") ? (
                <div className="w-full h-full flex items-center justify-center bg-muted rounded-md border">
                  <img
                    src={viewBlobUrl}
                    alt={viewingDocument.name}
                    className="max-w-full max-h-full object-contain"
                    data-testid="img-admin-document-viewer"
                  />
                </div>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center bg-muted rounded-md border gap-4">
                  <File className="h-16 w-16 text-muted-foreground" />
                  <div className="text-center">
                    <p className="font-medium mb-1">Preview not available</p>
                    <p className="text-sm text-muted-foreground mb-4">
                      This file type cannot be previewed in the browser. Use the download button to save it.
                    </p>
                    <Button onClick={() => viewingDocument && downloadDocument(viewingDocument)} data-testid="button-admin-viewer-download-fallback">
                      <Download className="h-4 w-4 mr-2" />
                      Download File
                    </Button>
                  </div>
                </div>
              )
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showUploadDialog} onOpenChange={(open) => {
        setShowUploadDialog(open);
        if (!open) {
          setUploadedFileInfo(null);
          setNewDocument({
            name: "",
            description: "",
            category: "RESOURCE",
            visibility: "PUBLIC",
            isTemplate: false,
            trackId: "",
            cohortId: "",
          });
        }
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload Document</DialogTitle>
            <DialogDescription>
              Upload a new document to the platform. Choose visibility settings to control access.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>File</Label>
              {uploadedFileInfo ? (
                <div className="flex items-center gap-2 p-3 border rounded-md bg-muted/50">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{uploadedFileInfo.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {formatFileSize(uploadedFileInfo.size)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setUploadedFileInfo(null)}
                    data-testid="button-remove-file"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <ObjectUploader
                  kind="document"
                  maxFileSize={52428800}
                  onComplete={(result) => {
                    setUploadedFileInfo({
                      url: result.url,
                      name: result.name,
                      size: result.size,
                      mimeType: result.contentType,
                    });
                    if (!newDocument.name) {
                      setNewDocument(prev => ({ ...prev, name: result.name.replace(/\.[^/.]+$/, "") }));
                    }
                    toast({ title: "File uploaded successfully" });
                  }}
                  buttonClassName="w-full"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Select File to Upload
                </ObjectUploader>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="doc-name">Document Name *</Label>
              <Input
                id="doc-name"
                value={newDocument.name}
                onChange={(e) => setNewDocument(prev => ({ ...prev, name: e.target.value }))}
                placeholder="Enter document name"
                data-testid="input-doc-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="doc-description">Description</Label>
              <Textarea
                id="doc-description"
                value={newDocument.description}
                onChange={(e) => setNewDocument(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Brief description of the document"
                className="resize-none"
                data-testid="input-doc-description"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Category</Label>
                <Select
                  value={newDocument.category}
                  onValueChange={(v) => setNewDocument(prev => ({ ...prev, category: v }))}
                >
                  <SelectTrigger data-testid="select-doc-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TEMPLATE">Template</SelectItem>
                    <SelectItem value="AGREEMENT">Agreement</SelectItem>
                    <SelectItem value="RESOURCE">Resource</SelectItem>
                    <SelectItem value="SUBMISSION">Submission</SelectItem>
                    <SelectItem value="OTHER">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Visibility</Label>
                <Select
                  value={newDocument.visibility}
                  onValueChange={(v) => setNewDocument(prev => ({ ...prev, visibility: v, trackId: "", cohortId: "" }))}
                >
                  <SelectTrigger data-testid="select-doc-visibility">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PUBLIC">Public</SelectItem>
                    <SelectItem value="COHORT">Cohort Only</SelectItem>
                    <SelectItem value="TRACK">Track Only</SelectItem>
                    <SelectItem value="PRIVATE">Private</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {newDocument.visibility === "TRACK" && (
              <div className="space-y-2">
                <Label>Track</Label>
                <Select
                  value={newDocument.trackId}
                  onValueChange={(v) => setNewDocument(prev => ({ ...prev, trackId: v }))}
                >
                  <SelectTrigger data-testid="select-doc-track">
                    <SelectValue placeholder="Select a track" />
                  </SelectTrigger>
                  <SelectContent>
                    {(tracks ?? []).map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(!tracks || tracks.length === 0) && (
                  <p className="text-xs text-muted-foreground">
                    No tracks found. Create tracks before uploading track-scoped documents.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Only members assigned to this track will see this document.
                </p>
              </div>
            )}

            {newDocument.visibility === "COHORT" && (
              <div className="space-y-2">
                <Label>Cohort</Label>
                <Select
                  value={newDocument.cohortId}
                  onValueChange={(v) => setNewDocument(prev => ({ ...prev, cohortId: v }))}
                >
                  <SelectTrigger data-testid="select-doc-cohort">
                    <SelectValue placeholder="Select a cohort" />
                  </SelectTrigger>
                  <SelectContent>
                    {(cohorts ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(!cohorts || cohorts.length === 0) && (
                  <p className="text-xs text-muted-foreground">
                    No cohorts found. Create a cohort before uploading cohort-scoped documents.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Only members of this cohort will see this document.
                </p>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Checkbox
                id="is-template"
                checked={newDocument.isTemplate}
                onCheckedChange={(checked) => setNewDocument(prev => ({ ...prev, isTemplate: !!checked }))}
                data-testid="checkbox-is-template"
              />
              <Label htmlFor="is-template" className="cursor-pointer">
                Mark as template document
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowUploadDialog(false)}
              data-testid="button-cancel-upload"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateDocument}
              disabled={createDocumentMutation.isPending || !uploadedFileInfo}
              data-testid="button-create-document"
            >
              {createDocumentMutation.isPending ? "Creating..." : "Create Document"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
